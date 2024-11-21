let fs = require('fs');
let config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
let urlValidator = require('valid-url');
let express = require('express');
let bodyParser = require('body-parser');
let app = express();
let logger = require('./logger');
let roleDetector = require('./role-detector');
let pageSegmenter = require('./page-segmenter');
let pageRenderer = require('./page-renderer');
let vicramCalculator = require('./vicram');
let puppeteer = require('puppeteer');

app.use(bodyParser.json());
app.post('/', process);
app.post('/visual-complexity', vicram);

let server = app.listen(config.port, function () {
	let host = server.address().address;
	let port = server.address().port;

	console.log("App listening at http://%s:%s", host, port)
});

vicramCalculator.calculateVicram({
	"url": "http://elginakpinar.com/"
}, function (err, result) {
	if (err) {
		console.log(err);
	} else {
		console.log(result);
	}
});

function process(req, res){
	let url = req.body.url;
	let width = +req.body.width ? req.body.width : 1920;
	let height = +req.body.height ? req.body.height : 1080;
	let explainRoles = req.body.explainRoles;
	let agent = req.body.userAgent;
	let wait = req.body.wait;
	let t0 = 0;
	let t1 = 0;
	let t2 = 0;

    if(agent){
        agent = 'Mozilla/5.0 (Windows NT 6.1; WOW64; rv:27.0) Gecko/20100101 Firefox/27.0';
    }

    if(! wait || wait < 0){
        wait = 0;
    }

	let  sendErrorResponse = function(status, message){
		res.writeHead(status, {'Content-Type': 'application/json'});
		res.end(JSON.stringify({"success": false, "error": message}));
	};

	if(! urlValidator.isWebUri(url)){
		logger.error("Invalid url:" + url);
		return sendErrorResponse(400, "Invalid url!");
	}

	if(width < 0){
		logger.error("Invalid width:" + width);
		return sendErrorResponse(400, "Invalid width!");
	}

	if(height < 0){
		logger.error("Invalid height:" + height);
		return sendErrorResponse(400, "Invalid height!");
	}

	t0 = Date.now();

	pageRenderer.retrieve(url, width, height, function(nodeTree) {
		t1 = Date.now();

		let blockTree = null;
		let pageWidth = 0;
		let pageHeight = 0;
		let fontColor = null;
		let fontSize = null;

		if(nodeTree){
			pageWidth = nodeTree.attributes.width;
			pageHeight = nodeTree.attributes.height;
			fontColor = nodeTree.attributes.fontColor;
			fontSize = nodeTree.attributes.fontSize;
			blockTree = pageSegmenter.segment(nodeTree, width, height);
		}

		t2 = Date.now();

		blockTree.setLocationData();
		blockTree.calculateWhiteSpaceArea(true);

		if(blockTree){
			roleDetector.detectRoles(blockTree, pageWidth, pageHeight, fontSize, fontColor,
				explainRoles, sendResponse);
		} else {
			sendResponse(blockTree);
		}
	});

	function sendResponse(block){
		let t3 = Date.now();
		res.writeHead(200, {'Content-Type': 'application/json'});
		res.end(JSON.stringify({
			"success": true,
			"renderingTime": t1 - t0,
			"segmentationTime": t2 - t1,
			"reasoningTime": t3 - t2,
			"result": block.toJson()
		}));
	}
}

function vicram(req, res){
	vicramCalculator.calculateVicram(req.body, function (err, result) {
		if (err) {
			res.writeHead(400, {'Content-Type': 'application/json'});
			res.end(JSON.stringify({"success": false, "error": err}));
		} else {
			let t2 = Date.now();
			res.writeHead(200, {'Content-Type': 'application/json'});
			res.end(JSON.stringify({
				"success": true,
				"renderingTime": result.t1 - result.t0,
				"calculationTime": t2 - result.t1,
				"result": result
			}));
		}
	});
}

async function analyzeAndVisualize(url, width = 1920, height = 1080) {
    const browser = await puppeteer.launch({ headless: false });
    const page = await browser.newPage();
    
    await page.setViewport({
        width: width,
        height: height,
        deviceScaleFactor: 1,
    });

    await page.goto(url);
    const domTree = await page.evaluate(pageRenderer.preprocess);
    const blockTree = pageSegmenter.segment(domTree, width, height);
    
    await new Promise((resolve) => {
        roleDetector.detectRoles(blockTree, width, height, null, null, true, resolve);
    });

    await page.evaluate((blockData) => {
        const MAJOR_ROLES = ['Header', 'Footer', 'Article', 'Sidebar', 'Navigation', 'Container'];
        const ROLE_COLORS = {
            'Header': 'rgba(255, 99, 71, 0.2)',    // Tomato
            'Footer': 'rgba(106, 90, 205, 0.2)',   // SlateBlue
            'Article': 'rgba(60, 179, 113, 0.2)',  // MediumSeaGreen
            'Sidebar': 'rgba(238, 130, 238, 0.2)', // Violet
            'Navigation': 'rgba(255, 165, 0, 0.2)', // Orange
            'Container': 'rgba(135, 206, 235, 0.2)' // SkyBlue
        };

        const style = document.createElement('style');
        style.textContent = `
            .block-overlay {
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                pointer-events: none;
                z-index: 10000;
            }
            .block-highlight {
                position: absolute;
                border: 2px solid rgba(0, 0, 0, 0.3);
                box-sizing: border-box;
                transition: all 0.1s ease;
            }
            .block-label {
                position: sticky;
                top: 0;
                font-size: 12px;
                padding: 4px;
                background: rgba(255, 255, 255, 0.9);
                border: none;
                font-weight: bold;
                pointer-events: none;
            }
            .controls {
                position: fixed;
                top: 10px;
                right: 10px;
                background: white;
                padding: 10px;
                border: 1px solid #ccc;
                z-index: 10001;
                pointer-events: auto;
            }
        `;
        document.head.appendChild(style);

        const overlay = document.createElement('div');
        overlay.className = 'block-overlay';

        function isMajorStructuralElement(block) {
            if (MAJOR_ROLES.includes(block.role)) return true;
            
            const isLargeEnough = block.width > (window.innerWidth * 0.2) && 
                                block.height > (window.innerHeight * 0.1);
            
            const structuralTerms = ['main', 'content', 'wrapper', 'container', 'layout'];
            const hasStructuralName = structuralTerms.some(term => 
                (block.className && block.className.toLowerCase().includes(term)) ||
                (block.id && block.id.toLowerCase().includes(term))
            );

            return isLargeEnough && hasStructuralName;
        }

        const highlights = new Map();

        function createVisualBlocks(data, container, depth = 0) {
            if (!data || depth > 10) return;

            if (isMajorStructuralElement(data)) {
                const block = document.createElement('div');
                block.className = 'block-highlight';
                
                block.dataset.xpath = data.xpath;
                highlights.set(data.xpath, {
                    element: block,
                    originalX: data.topX,
                    originalY: data.topY,
                    width: data.width,
                    height: data.height
                });
                
                block.style.backgroundColor = ROLE_COLORS[data.role] || 'rgba(200, 200, 200, 0.2)';
                
                const label = document.createElement('div');
                label.className = 'block-label';
                label.textContent = `${data.role || 'Structure'} ${data.tagName ? `(${data.tagName})` : ''}`;
                block.appendChild(label);
                
                container.appendChild(block);
            }
            
            if (data.children && data.children.length > 0) {
                data.children.forEach(child => createVisualBlocks(child, container, depth + 1));
            }
        }

        function updateHighlightPositions() {
            const scrollX = window.pageXOffset;
            const scrollY = window.pageYOffset;

            highlights.forEach((info, xpath) => {
                info.element.style.left = `${info.originalX - scrollX}px`;
                info.element.style.top = `${info.originalY - scrollY}px`;
                info.element.style.width = `${info.width}px`;
                info.element.style.height = `${info.height}px`;
            });
        }

        window.addEventListener('scroll', updateHighlightPositions, { passive: true });
        window.addEventListener('resize', updateHighlightPositions, { passive: true });

        const controls = document.createElement('div');
        controls.className = 'controls';
        controls.innerHTML = `
            <button onclick="toggleOverlay()">Toggle Overlay</button>
            <button onclick="toggleLabels()">Toggle Labels</button>
        `;
        document.body.appendChild(controls);

        window.toggleOverlay = function() {
            overlay.style.display = overlay.style.display === 'none' ? 'block' : 'none';
        };

        window.toggleLabels = function() {
            const labels = overlay.getElementsByClassName('block-label');
            for (let label of labels) {
                label.style.display = label.style.display === 'none' ? 'block' : 'none';
            }
        };

        document.body.appendChild(overlay);
        createVisualBlocks(blockData, overlay);
        updateHighlightPositions();
    }, blockTree.toJson());

    return browser;
}

analyzeAndVisualize('https://en.wikipedia.org/wiki/Cat').then(browser => {
    // Browser stays open until you call browser.close()
    // You can interact with the visualization using the controls
    
    // Optionally close after some time:
    setTimeout(() => browser.close(), 600000); // Close after 1 minute
});