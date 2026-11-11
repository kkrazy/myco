const { chromium } = require('playwright');

(async () => {
  console.log('🚀 Launching chromium headful on macOS...');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  console.log('🌐 Navigating to https://opti.labxnow.ai/ ...');
  await page.goto('https://opti.labxnow.ai/', { waitUntil: 'networkidle' });

  console.log('🔍 Checking if already logged in or needs PAT...');
  // Wait a brief moment to ensure domestic state loading finishes
  await page.waitForTimeout(1500);
  
  const patInput = await page.$('#login-pat');
  if (patInput) {
    console.log('🔑 PAT Login form found! Entering the PAT token...');
    const token = process.env.GITHUB_PAT || 'your_github_pat_here';
    await page.fill('#login-pat', token);
    
    console.log('🖱️ Clicking the login button...');
    await page.click('#login-pat-submit');
    
    console.log('⏳ Waiting for navigation and landing page to load...');
    await page.waitForTimeout(3000);
  } else {
    console.log('✅ Already logged in (session cookies / token restored)!');
  }

  console.log('📊 Verifying Myco dashboard state...');
  const planTab = await page.waitForSelector('#sidebar', { timeout: 15000 });
  if (planTab) {
    console.log('🎉 Login verified! Landed on main view successfully.');
    
    // Keep it open for 15 seconds so the operator can inspect the UI
    console.log('⏳ Keeping the browser open for 15 seconds so you can inspect the loaded dashboard...');
    await page.waitForTimeout(15000);
  } else {
    console.error('❌ Failed to verify main dashboard. Login might have failed.');
  }

  console.log('🧹 Cleaning up and closing browser.');
  await browser.close();
  console.log('✨ Verification finished successfully.');
})().catch((err) => {
  console.error('💥 Fatal error during browser verification:', err);
  process.exit(1);
});
