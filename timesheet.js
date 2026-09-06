const puppeteer = require('puppeteer');
const nodemailer = require('nodemailer');

const config = {
    targetTime: process.env.TARGET_TIME || '12:00',
    targetHours: Number(process.env.TARGET_HOURS || 9),
    url: 'https://timesheet.ultimatix.net/timesheetEntry/#/Home',
    nonBillableInputXPath: '/html/body/app-root/div/app-layout/div/app-menus/mat-sidenav-container/mat-sidenav-content/main/app-timesheet/div/div[3]/div[2]/div[2]/div/div[5]/div[4]/div[3]/div[1]/table/tbody/tr/td[3]/div/div/input',
        emailFrom: process.env.EMAIL_FROM || 'theradimuthuramachandran@gmail.com',
        emailTo: process.env.EMAIL_TO || 'theradiramachandran@gmail.com',
    sessionDir: './session_data',
    timeout: 120000
};

const sleep = (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds));

async function sendEmailNotification(message) {
    const password = process.env.GMAIL_APP_PASSWORD;
    if (!password) {
        console.warn('Email notification skipped: GMAIL_APP_PASSWORD is not configured.');
        return false;
    }

    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: config.emailFrom,
            pass: password
        }
    });

    await transporter.sendMail({
        from: config.emailFrom,
        to: config.emailTo,
        subject: 'Timesheet daily status',
        text: `Checking today's date: ${new Date().toLocaleDateString()}\n${message}`
    });
    return true;
}

function getNextTargetTime() {
    const [targetHour, targetMinute] = config.targetTime.split(':').map(Number);
    if (!Number.isInteger(targetHour) || !Number.isInteger(targetMinute) ||
        targetHour < 0 || targetHour > 23 || targetMinute < 0 || targetMinute > 59) {
        throw new Error(`Invalid TARGET_TIME: ${config.targetTime}. Use HH:mm, for example 05:30.`);
    }

    const target = new Date();
    target.setHours(targetHour, targetMinute, 0, 0);
    if (target <= new Date()) target.setDate(target.getDate() + 1);
    return target;
}

async function waitForLogin(page) {
    if (!page.url().includes('auth.ultimatix.net')) return;

    console.log('Complete authentication in the browser window.');
    await page.waitForFunction(
        () => !window.location.href.includes('auth.ultimatix.net'),
        { timeout: config.timeout }
    );
}

async function readEnabledDate(page) {
    return page.evaluate(() => {
        const text = document.body.innerText.replace(/\s+/g, ' ');
        const match = text.match(/enabled\s+till\s+(\d+)(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})/i);
        if (!match) return null;

        const date = new Date(`${match[2]} ${match[1]}, ${match[3]} 00:00:00`);
        return Number.isNaN(date.getTime()) ? null : date.toISOString();
    });
}

async function selectDate(page, day) {
    await page.waitForFunction(() => document.querySelector(
        'td, [role="gridcell"], button, [class*="calendar-body-cell"], [class*="calendar"] [class*="day"]'
    ), { timeout: 10000 });

    return page.evaluate((dayNumber) => {
        const cells = Array.from(document.querySelectorAll(
            'td, [role="gridcell"], button, [aria-label], [title], [class*="calendar-body-cell"], [class*="calendar"] [class*="day"]'
        ));
        const cell = cells.find(candidate => {
            if (candidate.getClientRects().length === 0) return false;
            const label = `${candidate.getAttribute('aria-label') || ''} ${candidate.getAttribute('title') || ''}`;
            const text = `${candidate.innerText || ''} ${candidate.textContent || ''}`.trim();
            const firstNumber = text.match(/^(\d{1,2})(?:\s|$)/)?.[1];
            return new RegExp(`(?:^|\\D)${dayNumber}(?:\\D|$)`).test(label) ||
                Number(firstNumber) === dayNumber;
        });

        if (cell) {
            (cell.closest('button, [role="gridcell"], td') || cell).click();
            return true;
        }

        // The application opens on today's date, so no click is needed if it is already selected.
        const selectedDate = document.body.innerText.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+[A-Za-z]+\s+\d{4}\b/);
        return Number(selectedDate?.[1]) === dayNumber;
    }, day);
}

async function updateTask(page) {
    const headerClicked = await page.evaluate(() => {
        const textElements = Array.from(document.querySelectorAll('div, span, a, mat-panel-title'));
        const header = textElements.find(element => element.textContent?.includes('Unassigned Task'));
        if (!header) return false;
        header.click();
        return true;
    });

    if (!headerClicked) {
        return { status: 'no_header', message: 'Unassigned Task section not found.' };
    }

    try {
        await page.waitForFunction((inputXPath) => Boolean(
            document.evaluate(inputXPath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue
        ), { timeout: 10000 }, config.nonBillableInputXPath);
    } catch {
        return { status: 'no_input', message: 'Non-billable task input not found after expanding the section.' };
    }

    const inputState = await page.evaluate((targetHours, inputXPath) => {
        const input = document.evaluate(
            inputXPath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
        ).singleNodeValue;

        if (!input) return { status: 'no_input', message: 'Non-billable task input not found.' };
        if (input.disabled || input.readOnly) return { status: 'disabled', message: 'Input field is locked.' };

        const currentValue = Number.parseFloat(input.value) || 0;
        if (currentValue >= targetHours) {
            return { status: 'skipped', message: `Value is ${currentValue}; no update required.` };
        }

        input.focus();
        input.select();
        return { status: 'ready' };
    }, config.targetHours, config.nonBillableInputXPath);

    if (inputState.status !== 'ready') return inputState;

    const filledValue = await page.evaluate((targetHours, inputXPath) => {
        const input = document.evaluate(
            inputXPath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
        ).singleNodeValue;

        if (!input) return '';
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, String(targetHours));
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.blur();
        return input.value;
    }, config.targetHours, config.nonBillableInputXPath);

    if (Number.parseFloat(filledValue) !== config.targetHours) {
        return {
            status: 'fill_failed',
            message: `Could not fill the Non Billable input. Current value: ${filledValue || '(empty)'}.`
        };
    }

    const submit = await page.evaluate(() => {
        const submit = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"]'))
            .find(element => element.textContent?.trim() === 'Submit' || element.value === 'Submit');
        if (!submit) return false;

        submit.click();
        return true;
    });

    if (!submit) return { status: 'no_submit', message: 'Submit button not found.' };
    return { status: 'success', message: `Updated value to ${config.targetHours} and submitted.` };
}

async function run() {
    let runNumber = 0;
    while (process.env.GITHUB_ACTIONS !== 'true' || runNumber === 0) {
        runNumber += 1;
        if (process.env.GITHUB_ACTIONS === 'true') {
            console.log('Running from GitHub Actions schedule.');
        } else {
            const nextRun = getNextTargetTime();
            console.log(`Waiting until ${nextRun.toLocaleString()}...`);
            await sleep(nextRun.getTime() - Date.now());
        }

        const browser = await puppeteer.launch({
            headless: process.env.HEADLESS === 'true',
            args: ['--start-maximized'],
            userDataDir: config.sessionDir
        });

        try {
            const pages = await browser.pages();
            const page = pages[0] || await browser.newPage();
            await Promise.all(pages.slice(1).map(existingPage => existingPage.close()));
            page.setDefaultTimeout(config.timeout);
            page.on('dialog', dialog => dialog.dismiss().catch(() => {}));

            await page.goto(config.url, { waitUntil: 'networkidle2' });
            await waitForLogin(page);
            await page.waitForFunction(() => document.body.innerText.includes('Timesheet entry enabled till'));

            const today = new Date();
            today.setHours(0, 0, 0, 0);
            console.log(`Checking today's date: ${today.toLocaleDateString()}`);
            if (!await selectDate(page, today.getDate())) {
                throw new Error(`Calendar cell for ${today.toLocaleDateString()} was not found.`);
            }

            await page.waitForFunction(() => document.body.innerText.includes('Unassigned Task'));
            const result = await updateTask(page);
            console.log(result.message);
            if (result.status === 'success' || result.status === 'skipped') {
                try {
                    if (await sendEmailNotification(result.message)) {
                        console.log(`Email notification sent to ${config.emailTo}.`);
                    }
                } catch (error) {
                    console.warn('Email notification failed:', error.message);
                }
            }
        } finally {
            await browser.close();
        }
    }
}

run().catch(error => {
    console.error('Automation failed:', error.message);
    process.exitCode = 1;
});