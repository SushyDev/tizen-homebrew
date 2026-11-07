'use strict';

const MAX_LINES = 400;

const escaped = (value) => String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// The pairing code is logged at start, and this bundle is readable by anyone on the network.
const redactor = (secret) => (text) => (secret ? String(text).split(secret).join('······') : String(text));

const findings = ({ device, hasCertificates, lines }) => {
    const found = [];

    if (!device) {
        found.push({ tone: 'warn', text: 'The service has only just started and has not checked the TV yet. Reload in a few seconds.' });
    } else if (device.onTv && !device.ready) {
        found.push({
            tone: 'bad',
            text: device.reason === 'debugModeOff'
                ? 'Developer Mode is off. Turn it on in Apps › 12345 › Settings, then restart the TV.'
                : 'The TV cannot install apps by itself yet. Set Host PC IP to 127.0.0.1 in Apps › 12345 › Settings, then restart the TV (hold the power button until the logo shows).'
        });
    }

    if (device && device.onTv && !hasCertificates) {
        found.push({ tone: 'warn', text: 'No signing certificate is stored on the TV, so packages built by other people cannot be re-signed. Run the installer again.' });
    }

    const errors = lines.filter((line) => line.level === 'err');
    if (errors.length) found.push({ tone: 'bad', text: `The log has ${errors.length} error${errors.length === 1 ? '' : 's'}; the newest: ${errors[errors.length - 1].text}` });

    if (!found.length) found.push({ tone: 'ok', text: 'Everything this page can check looks fine.' });

    return found;
};

const bundle = ({ build, startedAt, runtime, device, hasCertificates, addresses, lines, secret }) => {
    const clean = redactor(secret);
    const kept = lines.slice(-MAX_LINES).map((line) => ({
        t: line.t,
        facility: line.facility,
        level: line.level,
        text: clean(line.text)
    }));

    const state = device ? Object.assign({}, device) : null;
    if (state) delete state.duid;

    return {
        app: 'homebrew',
        version: build,
        startedAt,
        uptimeSeconds: Math.round(process.uptime()),
        runtime,
        device: state,
        hasCertificates,
        addresses,
        findings: findings({ device, hasCertificates, lines: kept }),
        log: kept
    };
};

const asText = (report) => [
    `tizen homebrew ${report.version}, up ${report.uptimeSeconds}s, ${report.runtime}`,
    `tizen ${(report.device && report.device.platformVersion) || '?'}, sdb ${report.device && report.device.ready ? 'ready' : 'not ready'}${report.device && report.device.reason ? ` (${report.device.reason})` : ''}`,
    ...report.findings.map((found) => `${found.tone}: ${found.text}`),
    '',
    ...report.log.slice(-80).map((line) => `[${(line.t / 1000).toFixed(3)}] ${line.facility}: ${line.text}`)
].join('\n');

const STYLE = `body{margin:0;font:16px/1.45 system-ui,sans-serif;background:#0d2f42;color:#e8f3f9}
main{max-width:720px;margin:0 auto;padding:20px 16px 48px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}
.meta{color:#9fc3d6;font-size:14px}
.finding{padding:12px 14px;border-radius:8px;margin:8px 0;background:#15435c;border-left:4px solid #7fe3ff}
.finding.bad{border-color:#ff8a8a}.finding.warn{border-color:#ffd27a}.finding.ok{border-color:#7ad4c6}
button{font:inherit;font-weight:600;padding:12px 18px;border-radius:8px;border:0;margin:6px 8px 6px 0;background:#7fe3ff;color:#06222f}
button.quiet{background:#24566f;color:#e8f3f9}
#code{font:700 32px ui-monospace,monospace;letter-spacing:.08em;margin:8px 0}
pre{white-space:pre-wrap;word-break:break-word;font:12px/1.5 ui-monospace,monospace;background:#071d29;padding:12px;border-radius:8px;max-height:60vh;overflow:auto}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;margin:0}dt{color:#9fc3d6}dd{margin:0;word-break:break-word}`;

const SCRIPT = `
var report = JSON.parse(document.getElementById('report').textContent);
var text = document.getElementById('text').textContent;
var say = function (message) { document.getElementById('said').textContent = message; };
var copy = function (value, done) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(value).then(done, function () { fallback(value, done); });
  fallback(value, done);
};
var fallback = function (value, done) {
  var area = document.createElement('textarea'); area.value = value; document.body.appendChild(area); area.select();
  try { document.execCommand('copy'); done(); } catch (e) { say('Copy failed: select the log below and copy it by hand.'); }
  document.body.removeChild(area);
};
document.getElementById('copy').onclick = function () { copy(text, function () { say('Copied. Paste it in Discord.'); }); };
var send = document.getElementById('send');
if (send) send.onclick = function () {
  send.disabled = true; say('Sending…');
  var request = new XMLHttpRequest();
  request.open('POST', send.getAttribute('data-to') + '/api/reports');
  request.setRequestHeader('content-type', 'application/json');
  request.onload = function () {
    try {
      var answer = JSON.parse(request.responseText);
      if (!answer.code) throw new Error(answer.error || 'no code');
      document.getElementById('code').textContent = answer.code;
      say('Post this code in Discord. The support bot reads the report from it.');
      document.getElementById('codecopy').hidden = false;
    } catch (e) { say('The support server answered oddly (' + request.status + '). Use Copy report instead.'); send.disabled = false; }
  };
  request.onerror = function () { say('Could not reach the support server from this phone. Use Copy report instead.'); send.disabled = false; };
  request.send(JSON.stringify({ app: 'homebrew', version: report.version, report: report }));
};
document.getElementById('codecopy').onclick = function () { copy(document.getElementById('code').textContent, function () { say('Code copied.'); }); };
`;

const page = (report, supportUrl) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tizen Homebrew diagnostics</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>Tizen Homebrew diagnostics</h1>
<div class="meta">Version ${escaped(report.version)} · Tizen ${escaped((report.device && report.device.platformVersion) || '?')} · up ${escaped(report.uptimeSeconds)}s</div>

<h2>What this page found</h2>
${report.findings.map((found) => `<div class="finding ${found.tone}">${escaped(found.text)}</div>`).join('\n')}

<h2>Get help</h2>
${supportUrl ? `<button id="send" data-to="${escaped(supportUrl)}">Send to support</button>` : ''}
<button id="copy" class="quiet">Copy report</button>
<div id="code"></div>
<button id="codecopy" class="quiet" hidden>Copy code</button>
<p id="said" class="meta">${supportUrl ? 'Send to support gives you a short code to post in Discord.' : 'Copy the report and paste it in Discord.'}</p>

<h2>This TV</h2>
<dl>
<dt>Runtime</dt><dd>${escaped(report.runtime)}</dd>
<dt>Addresses</dt><dd>${escaped(report.addresses.join(', ') || 'none')}</dd>
<dt>sdb</dt><dd>${escaped(report.device ? (report.device.ready ? 'ready' : report.device.sdbDetail || report.device.reason || 'not ready') : 'not checked yet')}</dd>
<dt>Certificates</dt><dd>${report.hasCertificates ? 'stored' : 'none'}</dd>
</dl>

<h2>Log</h2>
<pre id="text">${escaped(asText(report))}</pre>
</main>
<script type="application/json" id="report">${JSON.stringify(report).replace(/</g, '\\u003c')}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;

module.exports = { bundle, page, asText, findings };
