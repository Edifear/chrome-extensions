// Example storyboard: node example.mjs <url> <out.mp4>
// Run it from (or copy it into) a project that has Playwright installed, so `import 'playwright'`
// resolves; the recorder itself has no dependencies.
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { Recorder } from './recorder.mjs'; // use this skill's absolute path when the script lives elsewhere

const [url = 'https://example.com', out = 'walkthrough.mp4'] = process.argv.slice(2);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const rec = await Recorder.attach(page, { workDir: path.join(os.tmpdir(), 'flow-recorder-work') });

try {
    await page.goto(url, { waitUntil: 'domcontentloaded' }); // before capture: the video opens on a loaded page
    await rec.startCapture();

    await rec.caption('The landing page explains what the domain is for');
    await rec.check(page.getByRole('heading').first());
    await rec.highlight(page.locator('p').first());

    await rec.caption('Following the link opens the documentation');
    await rec.click(page.getByRole('link').first());

    await rec.stopCapture();
    await rec.render(out);
    console.log(`Saved ${out}`);
} finally {
    await browser.close();
}
