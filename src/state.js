'use strict';

// Values that must survive between runs: the course spans days, and later
// exercises need numbers produced by earlier ones (asset, RFQ, contract, PO,
// production order, sales order, delivery...). Also caches the launchpad hash
// found for each app title so later runs can skip the search.

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

class State {
  constructor(cfg) {
    this.varsFile = path.join(cfg.stateDir, 'vars.json');
    this.appsFile = path.join(cfg.stateDir, 'apps.json');
    this.vars = readJson(this.varsFile);
    this.apps = readJson(this.appsFile);
    // apps.yaml (checked in) lets testers pin a hash per app title.
    this.pinnedApps = fs.existsSync(cfg.appsFile) ? YAML.parse(fs.readFileSync(cfg.appsFile, 'utf8')) || {} : {};
  }

  // Writes only the values this run changed, on top of the file as it is now, so runs started in
  // parallel do not overwrite each other's values.
  saveVars(vars) {
    const changed = Object.keys(vars).filter((k) => vars[k] !== this.vars[k]);
    this.vars = { ...vars };
    const onDisk = readJson(this.varsFile);
    for (const k of changed) onDisk[k] = vars[k];
    writeJson(this.varsFile, onDisk);
  }

  appHash(title) {
    return this.pinnedApps[title] || this.apps[title];
  }

  rememberApp(title, hash) {
    if (!hash || this.pinnedApps[title] || this.apps[title] === hash) return;
    this.apps[title] = hash;
    writeJson(this.appsFile, this.apps);
  }

  forgetApp(title) {
    delete this.apps[title];
    writeJson(this.appsFile, this.apps);
  }

  static reset(cfg) {
    for (const f of ['vars.json', 'apps.json']) fs.rmSync(path.join(cfg.stateDir, f), { force: true });
  }
}

module.exports = { State };
