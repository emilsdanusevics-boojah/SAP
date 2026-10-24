# SAP Fiori task tester

Walks through SAP S/4HANA Cloud learning exercises, step by step, the way a student
would, and reports which steps pass or fail. You write each exercise as a short YAML
file. The runner logs in, opens the apps, fills fields, clicks buttons, checks the
system messages, and records document numbers for the next exercises.

Default target: `https://my414802.s4hana.cloud.sap/ui#Shell-home`

## Setup

```bash
npm install
npx playwright install chromium       # first time only
cp .env.example .env                  # then put your SAP_USER / SAP_PASSWORD in .env
```

`.env` holds your practice-system login. It is git-ignored, so keep it that way.
After the first login, the session is saved in `.auth/state.json` and reused until
it expires.

If the tenant asks for MFA or a first-time password change, log in once by hand:

```bash
node run.js --headed --manual-login
```

## Running

```bash
node run.js                         # all tasks in ./tasks
node run.js tasks/01-create-sales-order.yaml
node run.js --grep sales            # by id, title or tag
node run.js --headed --slowmo 300   # watch it happen
node run.js --trace                 # per-task Playwright trace for debugging
node run.js --var salesOrder=1234   # supply a value an earlier task would capture
node run.js --validate              # check YAML files only, no browser
npm run selftest                    # run the example tasks against an offline mock launchpad
```

Output goes to `results/`:
- `report.html`: one row per task, with each step's status, timing, error and screenshot.
- `results.json`: the same data, machine-readable.
- `junit.xml`: for CI.
- A screenshot of every failing step.

The exit code is 0 only if every task passed.

## Writing a task from an exercise sheet

Map each sentence of the exercise to one step:

| Exercise says | Step |
|---|---|
| Open the app *Create Sales Orders* | `- openApp: SalesOrder-create` or `- openApp: { title: Create Sales Orders }` |
| Start transaction VA03 | `- transaction: VA03` |
| Enter *1710* in *Sales Organization* | `- fill: { Sales Organization: "1710" }` |
| Choose *Standard Order* from the dropdown | `- select: { label: Order Type, value: Standard Order }` |
| Choose *Save* / *Go* / *Continue* | `- click: Save` |
| Press Enter | `- press: Enter` |
| Enter *TG11* in the first item row | `- fillCell: { row: 1, column: Material, value: TG11 }` |
| Note the document number | `- expectMessage: { regex: "Order (\\d+) has been saved", capture: { var: orderNo, regex: "Order (\\d+)" } }` |
| Check the field shows X | `- expectField: { label: Net Value, value: "100.00" }` |
| Check X appears on screen | `- expectText: X` |

```yaml
id: SD-01                      # unique, shows in the report
title: Create a standard sales order
tags: [sales]
vars:                          # usable as ${name}
  soldTo: "17100001"
steps:
  - openApp: SalesOrder-create
  - fill:
      Order Type: OR
      Sales Organization: "1710"
  - press: Enter
  - name: Header data          # optional label for the report
    fill: { Sold-To Party: "${soldTo}", Cust. Reference: "PO-${rand}" }
  - click: Save
  - expectMessage: { contains: "has been saved", capture: { var: salesOrder } }
```

Quote values that look like numbers (`"0010"`), or YAML drops the leading zeros.

### All actions

| Action | Argument |
|---|---|
| `openApp` | hash string, or `{ hash, params }`, or `{ title }` (uses launchpad search) |
| `transaction` | GUI transaction code, opened inside the launchpad |
| `home`, `back` | none |
| `fill` | `{ label, value }`, or a map `{ Label: value, ... }`. Options: `selector`, `enter: true`, `type: true` (sends real keystrokes), `frame: app\|main` |
| `select` | `{ label, value }` for a dropdown or combo box |
| `check` / `uncheck` | checkbox label |
| `click` | button, link or tab text, or `{ text, role, index, selector, dialog: true, double: true }` |
| `fillCell` | `{ row, column, value, enter }`. Row is 1-based, column is the header text |
| `press` | key name (`Enter`, `F8`, `Control+S`), or `{ key, label }` |
| `wait` | milliseconds |
| `waitFor` | text, or `{ text \| selector, state: hidden }` |
| `expectText` | text, or `{ text, exact, not: true }` |
| `expectField` | `{ label, value }`, `{ label, contains }`, or `{ label, notEmpty: true }` |
| `expectMessage` | text, or `{ contains \| regex, notContains, capture: { var, regex } }` |
| `expectNoError` | none. Fails if an error message box or strip is visible |
| `capture` | `{ var, from: message\|field\|text\|url, label, selector, regex }` |
| `set` | `{ name: value }` |
| `screenshot` | file name |
| `log` | note to print |
| `pause` | opens the Playwright inspector (use with `--headed`) |

Any step can also have:
- `name`: the label shown in the report.
- `optional: true`: a failure becomes a warning and the task continues.
- `timeout`: in milliseconds.

### Built-in variables

| Variable | Value |
|---|---|
| `${today}`, `${date(+7)}` | Dates in `SAP_DATE_FORMAT`. Set this to match your SAP user settings. |
| `${rand}` | A random 6-digit number. |
| `${timestamp}` | The current time, as `yyyymmddhhmmss`. |
| `${env.NAME}` | The value of environment variable `NAME`. |

A value captured in one task stays available to the tasks after it in the same run.

## How elements are found

A field is found by its **on-screen label**, tried in this order:
1. The accessible label (UI5 controls).
2. A textbox or combo-box name.
3. The label with trailing `:` or `*` ignored.
4. The tooltip.
5. The first input after matching label text (classic WebGUI screens).

The runner searches an open dialog first, then the app's iframe (GUI transactions
run inside one), then the launchpad shell. After each action it waits until UI5
reports idle.

Labels depend on the logon language, so the runner logs on with `SAP_LANGUAGE`
(default `EN`).

If a label is ambiguous or missing, use a `selector:` instead. To find one, run
`npx playwright codegen https://my414802.s4hana.cloud.sap/ui`, click the element,
and copy the selector it suggests.

## Layout

```
run.js            CLI
src/runner.js     loads tasks, runs steps, handles failures
src/actions.js    the step actions listed above
src/ui5.js        Fiori/UI5 helpers: iframe detection, element lookup, idle waits, message capture
src/login.js      SAP Cloud Identity login and classic SAP logon, with session reuse
src/report.js     HTML, JSON and JUnit reports
tasks/            example exercises (sales order create, display, manage)
test/             offline mock launchpad and self-test
```
