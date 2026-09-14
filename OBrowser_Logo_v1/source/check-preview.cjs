const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('/Users/lixiaowei/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
async function main() {
  const browser = await chromium.launch({ headless:true, executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage({ viewport: {width:768, height:1000}, colorScheme:'light', deviceScaleFactor:1 });
  const errors=[];
  page.on('pageerror', e=>errors.push(e.message));
  await page.addInitScript(() => {
    window.__logoTweaks=[];
    window.Tweak=class {
      constructor({onChange}) { this.onChange=onChange; }
      addSelect(state,property,options) { window.__logoTweaks.push({state,property,options,render:this.onChange}); }
    };
  });
  await page.goto(process.argv[2], { waitUntil:'networkidle' });
  const frame = page.frames().find(f=>f.parentFrame());
  await frame.locator('#obrowser-identity img').first().waitFor();
  const checks=[];
  async function inspect(label) {
    await frame.waitForFunction(()=>Array.from(document.querySelectorAll('#obrowser-identity img')).every(i=>i.complete && i.naturalWidth>0));
    checks.push(await frame.evaluate(label=>({
      label,
      viewport:document.documentElement.clientWidth,
      scrollWidth:document.documentElement.scrollWidth,
      images:Array.from(document.querySelectorAll('#obrowser-identity img')).every(i=>i.complete && i.naturalWidth>0),
      background:getComputedStyle(document.querySelector('.ob-hero')).backgroundColor,
      height:document.getElementById('obrowser-identity').getBoundingClientRect().height
    }),label));
  }
  await inspect('light-736');
  await frame.locator('#obrowser-identity').screenshot({path:path.join(__dirname,'qa-preview-736.png')});
  // The standalone wrapper supplies its own inert Tweak. Bind a local test
  // implementation after wrapper initialization and replay only our fragment.
  await frame.evaluate(()=>{
    window.__logoTweaks=[];
    window.Tweak=class {
      constructor({onChange}) { this.onChange=onChange; }
      addSelect(state,property,options) { window.__logoTweaks.push({state,property,options,render:this.onChange}); }
    };
    Function(document.querySelector('#obrowser-identity script').textContent)();
  });
  const oldSource=await frame.locator('.ob-main').getAttribute('src');
  await frame.evaluate(()=>{ const t=window.__logoTweaks.find(t=>t.property==='ink'); t.state.ink='mono'; t.render(); });
  await inspect('monochrome-interaction');
  const newSource=await frame.locator('.ob-main').getAttribute('src');
  if(oldSource===newSource) throw new Error('The monochrome control did not update the logo');
  await page.emulateMedia({colorScheme:'dark'});
  await frame.waitForFunction(()=>getComputedStyle(document.querySelector('.ob-hero')).backgroundColor==='rgb(21, 27, 44)');
  await inspect('dark-736');
  await frame.locator('#obrowser-identity').screenshot({path:path.join(__dirname,'qa-preview-dark.png')});
  await page.setViewportSize({width:352,height:1000});
  await inspect('dark-320');
  await frame.locator('#obrowser-identity').screenshot({path:path.join(__dirname,'qa-preview-320.png')});
  await page.emulateMedia({colorScheme:'light'});
  await frame.evaluate(()=>{ const t=window.__logoTweaks.find(t=>t.property==='ink'); t.state.ink='color'; t.render(); });
  await inspect('light-320');
  if(checks.some(c=>c.scrollWidth>c.viewport || !c.images)) throw new Error('Overflow or failed images');
  if(errors.length) throw new Error(errors.join('\n'));
  fs.writeFileSync(path.join(__dirname,'preview-checks.json'),JSON.stringify({checks,scriptErrors:errors,tweakVerified:true},null,2)+'\n');
  console.log(JSON.stringify({checks,scriptErrors:errors,tweakVerified:true},null,2));
  await browser.close();
}
main().catch(error=>{console.error(error);process.exitCode=1;});
