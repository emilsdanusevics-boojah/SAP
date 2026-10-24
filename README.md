# SAP IEE2E exercise tester

Automates the exercises of the SAP course **IEE2E, "Exploring End-to-End Business Processes in SAP"**
(course version 2608, 57 exercises), on the practice tenant
`https://my414802.s4hana.cloud.sap`. It works through each exercise the way a student
would, records the document numbers the course asks you to note, and reports pass or
fail for every step.

| Unit | Folder | Exercises |
|---|---|---|
| 4 Record-to-Report (FI, AP, AA, CO) | `tasks/unit4-record-to-report` | 1–20 |
| 6 Source-to-Pay (MM) | `tasks/unit6-source-to-pay` | 21–31 |
| 7 Design-to-Operate (PP) | `tasks/unit7-design-to-operate` | 32–46 |
| 8 Lead-to-Cash, Sales (SD) | `tasks/unit8-lead-to-cash-sales` | 47–54 |
| 9 Lead-to-Cash, Service (CS) | `tasks/unit9-lead-to-cash-service` | 55–57 |

> **Status:** I wrote the task files from the exercise guide without access to the tenant.
> I've tested the runner against an offline imitation of the launchpad (`npm run selftest`),
> but not against the real system. Expect to adjust some field labels and buttons on the
> first run; [Tuning a task](#tuning-a-task) shows how.

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env      # then set SAP_USER, SAP_PASSWORD, and check SAP_GROUP / SAP_DATE_FORMAT
```

- **`SAP_GROUP`** is the course's `###`. Leave it empty to use the last three digits
  of the user (for example, `F000035` gives `035`).
- **`SAP_BUSINESS_USER`**: only if you log on with an e-mail address. Set it to your SAP
  user name (for example `F030650`); it is used to find you in Maintain Business Users
  and for `${user}`.
- **`SAP_DATE_FORMAT`** and **`SAP_DECIMAL`** must match your SAP user settings.
  The default is `DD.MM.YYYY` with a comma as the decimal separator.
- Credentials and the saved login session stay local, in `.env` and `.state/`.
  Both are git-ignored.

## Running

```bash
node run.js --list                          # all exercises, in order
node run.js                                 # run everything (Unit 4 -> 9)
node run.js --grep unit6                    # one unit (tags: unit4, unit6, fi-ap, co, mm, pp, sd, cs, roles ...)
node run.js --grep "^IEE2E-0(3|4)$"         # specific exercises
node run.js --headed --slowmo 250           # watch it in a browser window
npm run test:headed                         # headed + waits for you at manual steps + inspector on failure
node run.js --show-state                    # values captured so far (PO, sales order, asset ...)
```

Results go to `results/`:
- `report.html`: every exercise and step, with failure screenshots and the captured values.
- `results.json`
- `junit.xml`

### How exercises chain together

The course builds on itself. For example, the supplier from exercise 7 is used again in
exercises 8, 9, 12, 22, 25, 49 and 54, and the purchase order from exercise 27 is used
in exercises 29 and 30. To support this:

- Each document number the guide asks you to note is captured into a variable, such as
  `poNo`, `salesOrder` or `assetNo`. It's saved in `.state/vars.json`, so a later run
  can pick up where an earlier one stopped.
- `requires:` lists the exercises a task depends on. If one of those fails in the
  current run, the dependent task is reported as *skipped* instead of failing in a
  confusing way.
- `node run.js --validate` warns when a task uses a value that no earlier exercise
  captures.
- You can supply any value by hand, for example `--var poNo=4500001234`.
- `--reset-state` forgets all saved values, for a fresh pass with a new group number.

Note that re-running an exercise that creates master data (business partner, cost
center, G/L account, material) will fail, because the object already exists. That
is expected.

### Manual steps

Some steps can't sensibly be automated. These are marked `manual:` in the task files:
- Exercise 18: preparing the Excel template.
- Joule prompts.
- Drag-and-drop in analytical reports.
- Reading T-account views.
- A few unusual dialogs (exercises 29, 37, 38).

By default a manual step is reported as **manual** and the run continues, so the
exercise shows as *partial*. With `--headed --interactive`, the run stops at each manual
step. Do the step in the browser, then press Enter in the terminal to continue.

### Course-specific notes

- **Role exercises** (1, 6, 10, 14, 21, 28, 32, 45, 47, 55) use a built-in
  Maintain Business Users flow. Roles that are already assigned are skipped.
  `Z_S4C_GENERIC_ROLE` is never removed; the code refuses to, even in exercise 47,
  which removes the earlier roles.
- **Exercise 13** posts the 2L entry directly, not through "Similar Journal Entry".
  The postings are the same.
- **Exercise 16** stays in display mode. It doesn't open Edit just to view the
  value help.
- **Exercise 18** needs the adapted course file. Set `F2121_FILE` in `.env` to its path.
- **Exercise 31**: the payment run ID `IE###` must be unique for each run date.
- **Exercise 33** switches F1-### to make-to-stock. The guide warns not to do this while
  a parallel Controlling training is using the system.
- **Exercise 48** only applies to a standalone Sales workshop. It is skipped unless named:
  `--grep IEE2E-48`.

## Tuning a task

When a step fails, the report shows the error and a screenshot. To fix it:

1. Re-run that exercise with `--headed --pause-on-fail`. The Playwright inspector
   opens at the failing step, and you can use its *Pick locator* tool on the element.
2. Edit the YAML. Usually that means changing a label (alternatives can be written
   `"Label A | Label B"`), adding `within: <section title>` to target the right
   section, or using a `selector:`.
3. Optionally, pin the app's launchpad link in `apps.yaml` to skip the search.

`npx playwright codegen https://my414802.s4hana.cloud.sap/ui` records your clicks and
suggests selectors.

## Task file format

```yaml
id: IEE2E-08
exercise: 8
title: "Post a Vendors Invoice and Analyze the Impact"   # quote titles containing ###
tags: [unit4, fi-ap]
requires: [IEE2E-07]
vars: { amount: "2200" }
steps:
  - openApp: { title: Create Supplier Invoice }      # launchpad search (cached), or { hash: ... }
  - fill: { Company Code: "1010", Invoice Date: "${today}" }
  - select: { label: Invoicing Party, value: "IEE2E-${grp}" }
  - fillCell: { within: G/L Account Items, row: 1, column: G/L Account, value: "65100${grp}" }
  - click: Post
  - expectMessage: { regex: "created", capture: { var: apInvoice1, regex: "(\\d{10})" } }
```

Inside `{ ... }`, quote any value that contains `${...}`.

### Actions

| Action | What it does |
|---|---|
| `openApp` | Opens an app: `{ title }` uses the launchpad search (cached), or give a `hash` |
| `transaction` | Opens a classic GUI transaction code inside the launchpad |
| `home`, `back`, `refresh` | Launchpad home, browser back, reload (F5) |
| `fill` | Fills fields by label: `{ Label: value, ... }` or `{ label, value }`. Options: `within`, `index`, `dialog`, `enter`, `type`. Write alternative labels as `A \| B` |
| `clear` | Empties a field |
| `select` | Picks a dropdown or combo box value: `{ label, value }`, or `{ combobox: n, value }` for unlabelled dropdowns (GUI) |
| `check` / `uncheck` | Sets a checkbox by label |
| `click` | Clicks a button, link, tab or menu item: text, or `[A, B]` alternatives. Options: `within`, `dialog`, `inRow`, `role`, `index` (-1 is the last match) |
| `selectRow` | Ticks the table row(s) containing a text (`contains`, `within`, `dialog`) |
| `openRow` | Navigates into the row containing a text (">" or a click on the row) |
| `fillCell` | Fills a table cell by column header. Pick the row with `row` (1-based; -1 is the last), `rowContains`, or `firstEmpty` |
| `clickCell` | Clicks the link or button in a table cell |
| `addFilter` | Adapt Filters: finds the filter, ticks it, OK |
| `upload` | Sets a file on the page's file input |
| `press` | Presses a key: `Enter`, `F3`, `F8`, `Control+S` ... |
| `wait`, `waitFor` | Pauses, or waits for text or an element |
| `expectText` | Text must be visible (`within`, `not`); alternatives as `A \| B` |
| `expectField` | A field's value must match (`value` / `contains` / `notEmpty`) |
| `expectMessage` | A success/status message must appear; can `capture` a number from it |
| `expectNoError` | Fails if an error message is shown |
| `capture` | Saves a variable `from:` a message, field, cell, text or URL |
| `set` | Sets variables directly |
| `assignBusinessRoles` | The Maintain Business Users flow: `{ add: [...], removeOthers }` |
| `manual` | A step done by a human (see [Manual steps](#manual-steps)) |
| `screenshot`, `log`, `closePopups`, `pause` | Utilities |

Any step can also carry:
- `name`: the label shown in the report.
- `optional: true`: a failure becomes a warning and the task continues.
- `timeout`: in milliseconds.

### Variables

| Variable | Meaning |
|---|---|
| `${grp}`, `${user}` | Your course number and your logon user |
| `${today}`, `${date(+10d)}`, `${date(+3m)}` | Today, or offset by days (d), months (m) or years (y) |
| `${monthStart}`, `${monthStart(-1m)}`, `${monthEnd}` | First or last day of a month |
| `${yearStart}`, `${yearEnd(+1y)}` | First or last day of a year |
| `${day(15, -1m)}` | The 15th of last month |
| `${on(1, 7)}` | January 7 of the current year |
| `${today\|YYYYMMDD}` | Any date variable in an explicit format |
| `${year}`, `${year(-1)}`, `${month}` | Current year (with offset) and month |
| `${num(2612.50)}` | A number written with your decimal separator |
| `${rand}`, `${timestamp}`, `${env.NAME}` | Random number, current time, environment variable |
| `${name}` | Anything set in `vars`, passed with `--var`, or captured by an earlier task |

## Layout

```
run.js              CLI
src/runner.js       loads tasks, order/prerequisites, runs steps, validation
src/actions.js      the actions above
src/ui5.js          Fiori/UI5/WebGUI helpers (iframes, sections, rows, idle waits, messages)
src/login.js        SAP Cloud Identity / classic logon with session reuse
src/state.js        values and app links kept between runs (.state/)
src/vars.js         ${...} variables and course date rules
src/report.js       HTML / JSON / JUnit reports
tasks/              the 57 course exercises, by unit
test/               offline mock launchpad + self-test (npm run selftest)
```
