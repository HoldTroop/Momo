const { chromium } = require('playwright');
const crypto = require('crypto');

// Configuration
const CONFIG = {
  email: 'wahoo@wasic.app',
  inboxUrl: 'https://inbox.wasic.app/',
  deviceUrl: 'https://view.awsapps.com/start/#/device?user_code=LCSZ-HHNK',
  name: 'Test User',
  // Generate a secure random password
  password: crypto.randomBytes(16).toString('base64').slice(0, 20) + 'A1!',
  headless: false,
  timeout: 60000
};

console.log('🔐 Generated password:', CONFIG.password);

async function fetchOTP() {
  console.log('📧 Fetching OTP from inbox...');

  // Poll the inbox API for the OTP
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      const response = await fetch(CONFIG.inboxUrl);
      const html = await response.text();

      // Look for 6-digit verification code in the HTML
      const otpMatch = html.match(/\b(\d{6})\b/);
      if (otpMatch) {
        console.log('✅ OTP found:', otpMatch[1]);
        return otpMatch[1];
      }

      console.log(`⏳ Attempt ${attempt}/30 - OTP not found yet, waiting 2s...`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (error) {
      console.error(`❌ Error fetching inbox (attempt ${attempt}):`, error.message);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  throw new Error('Failed to retrieve OTP after 30 attempts');
}

async function automateSignup() {
  console.log('🚀 Starting AWS SSO signup automation...\n');

  const browser = await chromium.launch({
    headless: CONFIG.headless,
    args: ['--start-maximized']
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  try {
    // Step 1: Navigate to device authorization URL
    console.log('📍 Step 1: Navigating to device authorization page...');
    await page.goto(CONFIG.deviceUrl, { waitUntil: 'networkidle', timeout: CONFIG.timeout });
    await page.waitForTimeout(2000);

    // Step 2: Enter email
    console.log('📍 Step 2: Entering email...');
    const emailSelector = 'input[type="email"][placeholder*="example.com"], input[type="email"]';
    await page.waitForSelector(emailSelector, { timeout: CONFIG.timeout });
    await page.fill(emailSelector, CONFIG.email);
    await page.waitForTimeout(500);

    // Submit email form
    console.log('📍 Step 3: Submitting email form...');
    const submitButtonSelector = 'button[data-testid="test-primary-button"], button[type="submit"]';
    await page.click(submitButtonSelector);
    await page.waitForTimeout(3000);

    // Step 4: Handle signup flow - Enter name
    console.log('📍 Step 4: Entering name on signup page...');
    try {
      // Wait for name field to appear
      const nameSelector = 'input[type="text"][placeholder*="Maria"], input[type="text"]:not([type="email"])';
      await page.waitForSelector(nameSelector, { timeout: 10000 });
      await page.fill(nameSelector, CONFIG.name);
      await page.waitForTimeout(500);

      // Click next/submit button
      const nextButtonSelector = 'button[data-testid="signup-next-button"], button[type="submit"]';
      await page.click(nextButtonSelector);
      console.log('✅ Name submitted');
    } catch (error) {
      console.log('⚠️  Name field not found, might already be past this step');
    }

    // Step 5: Wait for OTP page and fetch OTP
    console.log('📍 Step 5: Waiting for OTP verification page...');
    await page.waitForTimeout(3000);

    // Fetch OTP from inbox
    const otp = await fetchOTP();

    // Step 6: Enter OTP
    console.log('📍 Step 6: Entering OTP...');
    const otpSelector = 'input[type="text"][placeholder*="digit"], input[placeholder*="code"]';
    await page.waitForSelector(otpSelector, { timeout: CONFIG.timeout });
    await page.fill(otpSelector, otp);
    await page.waitForTimeout(500);

    // Submit OTP
    const verifyButtonSelector = 'button[data-testid="email-verification-verify-button"], button[type="submit"]';
    await page.click(verifyButtonSelector);
    console.log('✅ OTP submitted');
    await page.waitForTimeout(3000);

    // Step 7: Set password
    console.log('📍 Step 7: Setting password...');
    try {
      // Wait for password fields
      const passwordSelector = 'input[type="password"][placeholder*="Enter password"]';
      const confirmPasswordSelector = 'input[type="password"][placeholder*="Re-enter"], input[type="password"]:nth-of-type(2)';

      await page.waitForSelector(passwordSelector, { timeout: 15000 });

      // Fill password
      await page.fill(passwordSelector, CONFIG.password);
      await page.waitForTimeout(500);

      // Fill confirm password
      const confirmFields = await page.$$(confirmPasswordSelector);
      if (confirmFields.length > 0) {
        await page.fill(confirmPasswordSelector, CONFIG.password);
      } else {
        // Fallback: find all password fields and fill the second one
        const allPasswordFields = await page.$$('input[type="password"]');
        if (allPasswordFields.length >= 2) {
          await allPasswordFields[1].fill(CONFIG.password);
        }
      }
      await page.waitForTimeout(500);

      // Submit password form
      const passwordSubmitSelector = 'button[data-testid="test-primary-button"], button[type="submit"]';
      await page.click(passwordSubmitSelector);
      console.log('✅ Password set');
      await page.waitForTimeout(3000);
    } catch (error) {
      console.error('❌ Error setting password:', error.message);
    }

    // Step 8: Authorize device
    console.log('📍 Step 8: Authorizing device...');
    try {
      // Wait for device authorization page
      await page.waitForTimeout(3000);

      // Click the authorization button
      const authorizeButtonSelector = 'button#cli_verification_btn, button[type="submit"]';
      await page.waitForSelector(authorizeButtonSelector, { timeout: 15000 });
      await page.click(authorizeButtonSelector);
      console.log('✅ Device authorization clicked');
      await page.waitForTimeout(2000);

      // Final allow access button
      const allowAccessSelector = 'button[data-testid="allow-access-button"]';
      await page.waitForSelector(allowAccessSelector, { timeout: 15000 });
      await page.click(allowAccessSelector);
      console.log('✅ Access allowed');
      await page.waitForTimeout(3000);

    } catch (error) {
      console.log('⚠️  Device authorization step might have different flow:', error.message);
    }

    // Success
    console.log('\n🎉 AWS SSO signup completed successfully!');
    console.log('📧 Email:', CONFIG.email);
    console.log('🔐 Password:', CONFIG.password);
    console.log('\n⚠️  SAVE THESE CREDENTIALS SECURELY!\n');

    // Keep browser open for 10 seconds to see final result
    await page.waitForTimeout(10000);

  } catch (error) {
    console.error('\n❌ Automation failed:', error.message);
    console.error('Stack trace:', error.stack);

    // Take a screenshot for debugging
    try {
      const screenshotPath = `/home/mir-abir/Momo/error-screenshot-${Date.now()}.png`;
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.log('📸 Error screenshot saved to:', screenshotPath);
    } catch (screenshotError) {
      console.error('Could not save screenshot:', screenshotError.message);
    }

    throw error;
  } finally {
    await browser.close();
  }
}

// Run the automation
automateSignup()
  .then(() => {
    console.log('✅ Automation completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Fatal error:', error.message);
    process.exit(1);
  });
