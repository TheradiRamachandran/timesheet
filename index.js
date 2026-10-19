const puppeteer = require('puppeteer');

const config = {
    targetTime: process.env.TARGET_TIME || '03:08',
    targetHours: Number(process.env.TARGET_HOURS || 9),
    url: 'https://timesheet.ultimatix.net/timesheetEntry/#/Home',
    nonBillableInputXPath: "//*[@id='effortUnassign01' and @type='text' and @maxlength='5']",
    applyChanges: process.env.APPLY_TIMESHEET === 'true',
    sessionDir: './session_data',
    timeout: 120000
};

const sleep = (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds));

function getDaysInMonth(date = new Date()) {
    return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

function getNextTargetTime() {
    const [targetHour, targetMinute] = config.targetTime.split(':').map(Number);
    if (!Number.isInteger(targetHour) || !Number.isInteger(targetMinute) ||
        targetHour < 0 || targetHour > 23 || targetMinute < 0 || targetMinute > 59) {
        throw new Error(`Invalid TARGET_TIME: ${config.targetTime}. Use HH:mm, for example 05:30.`);
    }

    const now = new Date();
    const nowMinutes = (now.getHours() * 60) + now.getMinutes();
    const targetMinutes = (targetHour * 60) + targetMinute;
    const target = new Date(now);
    target.setHours(targetHour, targetMinute, 0, 0);

    if (targetMinutes === nowMinutes) return new Date();
    if (targetMinutes < nowMinutes) target.setDate(target.getDate() + 1);
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

async function closeInfoModal(page) {
    try {
        await page.waitForFunction(() => {
            const bodyText = document.body ? document.body.innerText : '';
            return bodyText.includes('Timesheet entry enabled till') || bodyText.includes('timesheet entry enabled till');
        }, { timeout: 10000 });

        const clicked = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"], [role="button"]'));
            const okButton = buttons.find(element => {
                const text = (element.textContent || element.value || '').replace(/\s+/g, ' ').trim().toUpperCase();
                return text === 'OK';
            });

            if (okButton) {
                okButton.click();
                return true;
            }

            return false;
        });

        if (clicked) {
            await page.waitForFunction(() => {
                const bodyText = document.body ? document.body.innerText : '';
                return !bodyText.includes('Timesheet entry enabled till') && !bodyText.includes('timesheet entry enabled till');
            }, { timeout: 5000 });
        }

        return clicked;
    } catch (error) {
        return false;
    }
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

        const selectedDate = document.body.innerText.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+[A-Za-z]+\s+\d{4}\b/);
        return Number(selectedDate?.[1]) === dayNumber;
    }, day);
}

async function updateTask(page) {
    const inputVisible = await page.evaluate(inputXPath => Boolean(
        document.evaluate(inputXPath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue
    ), config.nonBillableInputXPath);

    if (!inputVisible) {
        const headerClicked = await page.evaluate(() => {
            const header = Array.from(document.querySelectorAll('button, [role="button"], mat-panel-title'))
                .find(element => (element.innerText || element.textContent || '').includes('Unassigned Task'));
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
    }

    const inputState = await page.evaluate((targetHours, inputXPath) => {
        const input = document.evaluate(
            inputXPath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
        ).singleNodeValue;

        if (!input) return { status: 'no_input', message: 'Non-billable task input not found.' };
        if (input.disabled || input.readOnly) return { status: 'disabled', message: 'Input field is locked.' };

        const task = (input.closest('tr')?.innerText || '').replace(/\s+/g, ' ').trim();
        const rawValue = input.value.trim();
        const currentValue = rawValue === '' ? 0 : Number(rawValue);
        if (!Number.isFinite(currentValue) || currentValue < 0) {
            return { status: 'invalid_value', message: `Input contains an unexpected value: ${input.value}.` };
        }
        if (currentValue >= targetHours) {
            return { status: 'skipped', message: `${task}: Non Billable value is ${currentValue}; no update required.` };
        }

        return { status: 'ready', currentValue, task };
    }, config.targetHours, config.nonBillableInputXPath);

    if (inputState.status !== 'ready') return inputState;
    if (!config.applyChanges) {
        return {
            status: 'dry_run',
            message: `Dry run: would change Non Billable hours for "${inputState.task}" from ${inputState.currentValue} to ${config.targetHours}; nothing was submitted.`
        };
    }

    const filledValue = await page.evaluate((targetHours, inputXPath) => {
        const input = document.evaluate(
            inputXPath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
        ).singleNodeValue;

        if (!input) return '';
        input.focus();
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
        const button = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"]'))
            .find(element => {
                const text = (element.textContent || element.value || '').replace(/\s+/g, ' ').trim();
                return text === 'Submit' && !element.disabled;
            });
        if (!button) return false;

        button.click();
        return true;
    });

    if (!submit) return { status: 'no_submit', message: 'Submit button not found.' };
    return { status: 'submitted', message: `Submit clicked for ${config.targetHours} Non Billable hours for "${inputState.task}". Verify the entry in Ultimatix.` };
}

async function run() {
    if (!Number.isFinite(config.targetHours) || config.targetHours <= 0 || config.targetHours > 24) {
        throw new Error(`Invalid TARGET_HOURS: ${process.env.TARGET_HOURS || config.targetHours}. Use a value greater than 0 and no more than 24.`);
    }

    const runOnce = process.env.GITHUB_ACTIONS === 'true' || process.env.RUN_NOW === 'true';
    let runNumber = 0;
    while (!runOnce || runNumber === 0) {
        runNumber += 1;
        if (process.env.GITHUB_ACTIONS === 'true') {
            console.log('Running from GitHub Actions schedule.');
        } else if (process.env.RUN_NOW !== 'true') {
            const nextRun = getNextTargetTime();
            console.log(`Waiting until ${nextRun.toLocaleString()}...`);
            const waitMs = Math.max(0, nextRun.getTime() - Date.now());
            await sleep(waitMs);

            const now = new Date();
            const nowMinutes = (now.getHours() * 60) + now.getMinutes();
            const targetMinutes = (Number(config.targetTime.split(':')[0]) * 60) + Number(config.targetTime.split(':')[1]);
            if (nowMinutes !== targetMinutes) {
                continue;
            }
        }

        const browser = await puppeteer.launch({
            headless: process.env.HEADLESS === 'true',
            args: [
                ...(process.env.GITHUB_ACTIONS === 'true' ? ['--no-sandbox'] : []),
                '--start-maximized'
            ],
            userDataDir: config.sessionDir,
            ignoreHTTPSErrors: true
        });

        try {
            const pages = await browser.pages();
            const page = pages[0] || await browser.newPage();
            await Promise.all(pages.slice(1).map(existingPage => existingPage.close()));
            page.setDefaultTimeout(config.timeout);
            page.on('dialog', dialog => dialog.dismiss().catch(() => {}));

            await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: config.timeout });
            await waitForLogin(page);
            await page.waitForFunction(() => document.body.innerText.includes('Timesheet entry enabled till'), { timeout: config.timeout });
            await closeInfoModal(page);

            const today = new Date();
            if (!await selectDate(page, today.getDate())) {
                throw new Error(`Calendar cell for ${today.toLocaleDateString()} was not found.`);
            }
            await page.waitForFunction(() => document.body.innerText.includes('Unassigned Task'), { timeout: config.timeout });

            const result = await updateTask(page);
            console.log(result.message);
            if (result.status === 'submitted') {
                console.warn('A submit action was sent; verify the final timesheet status in Ultimatix.');
            }
            break;
        } finally {
            await browser.close();
        }
    }
}

run().catch(error => {
    console.error('Automation failed:', error.message);
    process.exitCode = 1;
});