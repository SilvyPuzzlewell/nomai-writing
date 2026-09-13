const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadFrontend(files = ['spiral.js'], globals = {}) {
    const context = {
        console, URLSearchParams, setTimeout, clearTimeout,
        window: { location: { search: '' }, matchMedia: () => ({ matches: false }) },
        document: { addEventListener() {} }, navigator: {}, ...globals
    };
    vm.createContext(context);
    for (const file of files) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, '../frontend/js', file), 'utf8'), context, { filename: file });
    }
    if (files.includes('app.js')) vm.runInContext('globalThis.NomaiApp = NomaiApp', context);
    return context;
}
module.exports = { loadFrontend };
