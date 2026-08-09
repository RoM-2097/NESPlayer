'use strict';
const fs = require('fs');
for (const f of ['js/app.js', 'js/debugger.js', 'js/netplay.js']) {
  const s = fs.readFileSync(f, 'utf8');
  console.log('### ' + f);
  for (const kw of ['reloadROM', 'resetNES', 'requestIrq', 'IRQ_RESET', 'resetCore', 'resetApply']) {
    let idx = 0, count = 0;
    while ((idx = s.indexOf(kw, idx)) !== -1) { count++; idx += kw.length; }
    console.log('  ' + kw + ': ' + count + ' occurrence(s)');
  }
}
