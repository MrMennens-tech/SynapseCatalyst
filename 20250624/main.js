document.addEventListener('DOMContentLoaded', function() {
// Tab functionaliteit
const tabs = document.querySelectorAll('.material-tab');
const tabContents = document.querySelectorAll('.tab-content');
tabs.forEach(tab => {
    tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        tabContents.forEach(tc => tc.classList.remove('active'));
        document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
    });
});
// Accordion functionaliteit
const accordionItems = document.querySelectorAll('.accordion-item');
accordionItems.forEach(item => {
    const header = item.querySelector('.accordion-header');
    const checkbox = header.querySelector('input[type="checkbox"]');
    const arrow = header.querySelector('.accordion-arrow');
    header.addEventListener('click', (e) => {
        // Alleen uitklappen als je niet op de checkbox zelf klikt
        if (e.target !== checkbox) {
            item.classList.toggle('active');
        }
    });
    // Open standaard als aangevinkt
    checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
            item.classList.add('active');
        } else {
            item.classList.remove('active');
        }
    });
});
// --- Web Serial & Device Logic ---
let port = null;
let reader = null;
let writer = null;
let isConnected = false;
window.lastBreathValue = 0;
let settingsCache = {};

const statusDisplay = document.getElementById('statusDisplay');
const connectionButton = document.getElementById('connectionButton');
const disconnectButton = document.getElementById('disconnectButton');

// --- Statusblok bovenin ---
let lastBreathTimestamp = 0;
let statusMode = 'disconnected'; // 'disconnected', 'adapter', 'groovtube'
const headerStatusLive = document.getElementById('headerStatusLive');
const headerStatusText = document.getElementById('headerStatusText');
function setHeaderStatus(mode) {
    statusMode = mode;
    if (mode === 'groovtube') {
        headerStatusLive.style.background = '#e8f5e9';
        headerStatusLive.style.color = '#388e3c';
        headerStatusText.textContent = 'GroovTube actief verbonden';
    } else if (mode === 'adapter') {
        headerStatusLive.style.background = '#fff3e0';
        headerStatusLive.style.color = '#f57c00';
        headerStatusText.textContent = 'Adapter verbonden, wacht op data…';
    } else {
        headerStatusLive.style.background = '#eee';
        headerStatusLive.style.color = '#888';
        headerStatusText.textContent = 'Niet verbonden';
    }
}
setHeaderStatus('disconnected');

// --- Inspiratie slider: altijd negatieve waarde tonen en versturen
(function() {
    const inhaleSlider = document.getElementById('gpioInhaleThreshold');
    if (inhaleSlider) {
        function updateInhaleSlider() {
            const val = parseFloat(inhaleSlider.value);
            document.getElementById('gpioInhaleThresholdValue').textContent = val.toFixed(2);
            settingsCache['inhale_gpio_threshold'] = val;
            sendCommand('SET:settings::' + JSON.stringify({ 'inhale_gpio_threshold': val }));
        }
        inhaleSlider.addEventListener('input', updateInhaleSlider);
        // Bij settings ophalen
        function setInhaleSliderFromSettings(val) {
            inhaleSlider.value = val;
            document.getElementById('gpioInhaleThresholdValue').textContent = val;
        }
        // Hook in updateSlidersFromSettings
        const origUpdate = updateSlidersFromSettings;
        updateSlidersFromSettings = function(s) {
            origUpdate(s);
            if (s.inhale_gpio_threshold !== undefined) setInhaleSliderFromSettings(s.inhale_gpio_threshold);
        }
    }
})();

// --- Web Serial & Device Logic (aanvulling voor statusblok) ---
let breathTimeoutInterval = null;
function handleDeviceLine(line) {
    if (line.startsWith('BREATH_DATA:')) {
        const val = parseFloat(line.split(':')[1]);
        window.lastBreathValue = val;
        updateHeaderBreath(val);
        updateGpioTestbars(val);
        updateJoystickTestbar(val); // FIX: testbalk beweegt nu mee
        // Statusblok: als eerste data, status = groovtube
        lastBreathTimestamp = Date.now();
        setHeaderStatus('groovtube');
        if (!breathTimeoutInterval) {
            breathTimeoutInterval = setInterval(()=>{
                if (isConnected) {
                    if (Date.now() - lastBreathTimestamp > 2000) {
                        setHeaderStatus('adapter');
                    }
                }
            }, 500);
        }
    } else if (line.startsWith('SETTINGS::')) {
        try {
            const json = JSON.parse(line.split('::')[1]);
            settingsCache = json;
            updateSlidersFromSettings(json);
        } catch (e) { }
    } else if (line.startsWith('OK')) {
        setStatus('Instellingen opgeslagen', true);
    } else if (line.startsWith('ERROR')) {
        setStatus('Fout: ' + line, false);
    }
}
// Bij verbinden
async function connectDevice() {
    try {
        port = await navigator.serial.requestPort();
        await port.open({ baudRate: 115200 });
        setStatus('Verbonden met GroovTube', true);
        setHeaderStatus('adapter');
        isConnected = true;
        connectionButton.disabled = true;
        writer = port.writable.getWriter();
        listenToDevice();
        sendCommand('GET:settings');
    } catch (e) {
        setStatus('Verbinding mislukt: ' + e, false);
        setHeaderStatus('disconnected');
    }
}
// Bij verbreken
async function disconnectDevice() {
    try {
        if (reader) { await reader.cancel(); reader = null; }
        if (writer) { await writer.releaseLock(); writer = null; }
        if (port) { await port.close(); port = null; }
    } catch (e) {}
    isConnected = false;
    setStatus('Niet verbonden met apparaat', false);
    setHeaderStatus('disconnected');
    connectionButton.disabled = false;
    disconnectButton.disabled = true;
    if (breathTimeoutInterval) { clearInterval(breathTimeoutInterval); breathTimeoutInterval = null; }
}

function setStatus(text, ok) {
    statusDisplay.textContent = text;
    statusDisplay.className = 'status ' + (ok ? 'connected' : 'disconnected');
    connectionButton.disabled = !!ok;
    disconnectButton.disabled = !ok;
}

async function listenToDevice() {
    try {
        reader = port.readable.getReader();
        let buffer = '';
        while (isConnected) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) {
                const text = new TextDecoder().decode(value);
                buffer += text;
                let lines = buffer.split('\n');
                buffer = lines.pop();
                for (let line of lines) {
                    handleDeviceLine(line.trim());
                }
            }
        }
    } catch (e) {
        setStatus('Verbinding verbroken: ' + e, false);
        isConnected = false;
        connectionButton.disabled = false;
    }
}

function sendCommand(cmd) {
    if (writer) {
        writer.write(new TextEncoder().encode(cmd + '\n'));
    }
}

// --- Sliders & Settings ---
function updateSlidersFromSettings(s) {
    // 3,5mm Output
    if (s.blow_gpio_threshold !== undefined) {
        document.getElementById('gpioExhaleThreshold').value = s.blow_gpio_threshold;
        document.getElementById('gpioExhaleThresholdValue').textContent = s.blow_gpio_threshold;
    }
    if (s.inhale_gpio_threshold !== undefined) {
        document.getElementById('gpioInhaleThreshold').value = s.inhale_gpio_threshold;
        document.getElementById('gpioInhaleThresholdValue').textContent = s.inhale_gpio_threshold;
    }
    if (s.gpio_duration !== undefined) {
        document.getElementById('gpioDuration').value = s.gpio_duration;
        document.getElementById('gpioDurationValue').textContent = s.gpio_duration;
    }
    // TODO: andere sliders koppelen
}

function sliderSendSetting(id, key) {
    const el = document.getElementById(id);
    const val = el.type === 'range' || el.type === 'number' ? parseFloat(el.value) : el.value;
    document.getElementById(id+'Value').textContent = val;
    settingsCache[key] = val;
    sendCommand('SET:settings::' + JSON.stringify({ [key]: val }));
}
// 3,5mm Output sliders
['gpioExhaleThreshold','gpioInhaleThreshold','gpioDuration'].forEach((id,i) => {
    const key = i===0 ? 'blow_gpio_threshold' : i===1 ? 'inhale_gpio_threshold' : 'gpio_duration';
    const el = document.getElementById(id);
    el.addEventListener('input',()=>sliderSendSetting(id,key));
});

// --- Testbalken live koppelen ---
// updateGpioTestbars wordt al aangeroepen bij nieuwe ademdata

// --- Header ademwaarde live ---
function updateHeaderBreath(val) {
    document.getElementById('breathValueLiveHeader').textContent = val.toFixed(2);
}

// --- Testbalk functionaliteit voor 3,5mm Output ---
function updateGpioTestbars(currentValue) {
    // Centrale testbalk: 0 in het midden, -1 links, +1 rechts
    const inhaleThreshold = parseFloat(document.getElementById('gpioInhaleThreshold').value);
    const exhaleThreshold = parseFloat(document.getElementById('gpioExhaleThreshold').value);
    const testbar = document.getElementById('gpioCombinedTestbar');
    const inhaleMarker = document.getElementById('gpioInhaleMarker');
    const exhaleMarker = document.getElementById('gpioExhaleMarker');
    const liveDot = document.getElementById('gpioLiveDot');
    // Marker posities: ((waarde + 1) / 2) * 100
    const inhalePct = ((inhaleThreshold + 1) / 2) * 100;
    const exhalePct = ((exhaleThreshold + 1) / 2) * 100;
    inhaleMarker.style.left = inhalePct + '%';
    exhaleMarker.style.left = exhalePct + '%';
    inhaleMarker.style.background = '#1976d2';
    exhaleMarker.style.background = '#f57c00';
    // Live dot positie
    let dotPct = ((currentValue + 1) / 2) * 100;
    liveDot.style.left = dotPct + '%';
    liveDot.textContent = currentValue.toFixed(2);
    // Groen als gehaald
    if (currentValue <= inhaleThreshold || currentValue >= exhaleThreshold) {
        testbar.classList.add('testbar-hit');
        liveDot.classList.remove('testbar-dot-inactive');
    } else {
        testbar.classList.remove('testbar-hit');
        liveDot.classList.add('testbar-dot-inactive');
    }
}

// Joystick centrale testbalk logica (maxpunt)
function updateJoystickTestbar(currentValue) {
    const inhaleMax = parseFloat(document.getElementById('joystickInhaleMax').value);
    const exhaleMax = parseFloat(document.getElementById('joystickExhaleMax').value);
    const testbar = document.getElementById('joystickCombinedTestbar');
    const maxMarker = document.getElementById('joystickMaxMarker');
    const liveDot = document.getElementById('joystickLiveDot');
    // Marker kleur: blauw voor inademen, oranje voor uitademen
    if (currentValue < 0) {
        maxMarker.style.background = '#1976d2'; // blauw
    } else if (currentValue > 0) {
        maxMarker.style.background = '#f57c00'; // oranje
    } else {
        maxMarker.style.background = '#888'; // neutraal
    }
    // Bepaal maxpunt (links voor inademen, rechts voor uitademen)
    let maxPct = 50;
    if (currentValue < 0) {
        maxPct = ((inhaleMax + 1) / 2) * 100;
    } else if (currentValue > 0) {
        maxPct = ((exhaleMax + 1) / 2) * 100;
    }
    maxMarker.style.left = maxPct + '%';
    // Live dot positie
    let dotPct = ((currentValue + 1) / 2) * 100;
    liveDot.style.left = dotPct + '%';
    liveDot.textContent = currentValue.toFixed(2);
    // Balkkleur: altijd volledig grijs
    testbar.style.background = '#e0e0e0';
}

// Koppel sliders aan marker, value-display en testbalk
['joystickInhaleMax','joystickExhaleMax'].forEach(id => {
    const el = document.getElementById(id);
    const valEl = document.getElementById(id+'Value');
    el.addEventListener('input',()=>{
        valEl.textContent = el.value;
        updateJoystickTestbar(window.lastBreathValue || 0);
    });
});
// Koppel testbalk aan live ademdata
function joystickBreathListener(val) {
    updateJoystickTestbar(val);
}

// --- Knoppenmodus sliders functioneel maken ---
['expiratieThreshold','inspiratieThreshold'].forEach(id => {
    const el = document.getElementById(id);
    const valEl = document.getElementById(id+'Value');
    el.addEventListener('input',()=>{
        valEl.textContent = el.value;
        // Stuur direct naar device
        let key = id === 'expiratieThreshold' ? 'expiratie_threshold' : 'inspiratie_threshold';
        let val = parseFloat(el.value);
        settingsCache[key] = val;
        sendCommand('SET:settings::' + JSON.stringify({ [key]: val }));
    });
});

// --- Init ---
setStatus('Niet verbonden met apparaat', false);

// Zet event listeners voor verbind- en disconnectknop als laatste
connectionButton.onclick = connectDevice;
disconnectButton.onclick = disconnectDevice;

// Toon alleen de juiste controls bij Besturingsmodus
const controlModeSelect = document.getElementById('controlMode');
const joystickControls = document.getElementById('joystickControls');
const buttonControls = document.getElementById('buttonControls');
function updateControlModeUI() {
    if (controlModeSelect.value === 'joystick') {
        joystickControls.style.display = '';
        buttonControls.style.display = 'none';
    } else {
        joystickControls.style.display = 'none';
        buttonControls.style.display = '';
    }
}
controlModeSelect.addEventListener('change', updateControlModeUI);
updateControlModeUI();

// === MEETLOGICA EN LIVE TABEL/GRAFIEK ===
let measurementActive = false;
let measurementData = [];
let measurementActions = [];
let measurementType = 'beide';
let measurementChart = null;
let measurementActionNr = 1;
const DREMPEL = 0.025;

const startBtn = document.getElementById('startMeasurement');
const stopBtn = document.getElementById('stopMeasurement');
const exportBtn = document.getElementById('exportPDF');
const tableDiv = document.getElementById('measurementTable');
const chartCanvas = document.getElementById('measurementChart');
const summaryDiv = document.getElementById('measurementSummary');

function resetMeasurement() {
    measurementData = [];
    measurementActions = [];
    measurementActionNr = 1;
    tableDiv.innerHTML = '';
    summaryDiv.innerHTML = '';
    if (measurementChart) measurementChart.destroy();
    measurementChart = null;
}

function getMeasurementMeta() {
    return {
        name: document.getElementById('measurementName').value,
        date: document.getElementById('measurementDate').value,
        diameter: document.getElementById('measurementDiameter').value,
        type: document.getElementById('measurementType').value
    };
}

function renderMeasurementTable() {
    if (measurementActions.length === 0) {
        tableDiv.innerHTML = '<em>Nog geen ademacties gedetecteerd.</em>';
        return;
    }
    let html = '<table style="width:100%;border-collapse:collapse;text-align:center;">';
    html += '<tr style="background:#f5f5f5;"><th>#</th><th>Type</th><th>Maximale waarde</th><th>Duur (s)</th></tr>';
    measurementActions.forEach((a,i) => {
        let kleur = a.type === 'inspiratie' ? '#1976d2' : '#f57c00';
        html += `<tr><td>${i+1}</td><td style="color:${kleur};font-weight:bold;">${a.type.charAt(0).toUpperCase()+a.type.slice(1)}</td><td>${a.max.toFixed(3)}</td><td>${a.duration.toFixed(2)}</td></tr>`;
    });
    html += '</table>';
    tableDiv.innerHTML = html;
}

function renderMeasurementChart() {
    if (measurementChart) measurementChart.destroy();
    const labels = measurementActions.map((a,i) => `${a.type.charAt(0).toUpperCase()}${a.type.slice(1)} ${i+1}`);
    const dataInspiratie = measurementActions.map(a => a.type === 'inspiratie' ? a.max : null);
    const dataExpiratie = measurementActions.map(a => a.type === 'expiratie' ? a.max : null);
    measurementChart = new Chart(chartCanvas, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Inspiratie',
                    data: dataInspiratie,
                    backgroundColor: '#1976d2',
                    stack: 'Stack 0',
                },
                {
                    label: 'Expiratie',
                    data: dataExpiratie,
                    backgroundColor: '#f57c00',
                    stack: 'Stack 0',
                }
            ]
        },
        options: {
            responsive: false,
            plugins: {
                legend: { display: true }
            },
            scales: {
                x: { stacked: true },
                y: { beginAtZero: true }
            }
        }
    });
}

function addMeasurementAction(type, max, duration) {
    measurementActions.push({type, max, duration});
    renderMeasurementTable();
    renderMeasurementChart();
}

let currentAction = null;
let lastType = null;

function processBreathValue(val, timestamp) {
    // Detecteer inspiratie/expiratie afhankelijk van testtype
    let type = null;
    if ((measurementType === 'expiratie' || measurementType === 'beide') && val > DREMPEL) type = 'expiratie';
    if ((measurementType === 'inspiratie' || measurementType === 'beide') && val < -DREMPEL) type = 'inspiratie';
    // Start nieuwe actie
    if (type && (!currentAction || currentAction.type !== type)) {
        if (currentAction && currentAction.max !== null) {
            // Einde vorige actie
            addMeasurementAction(currentAction.type, currentAction.max, (timestamp - currentAction.startTime)/1000);
        }
        currentAction = {type, startTime: timestamp, max: val};
    }
    // Update max binnen actie
    if (currentAction && currentAction.type === type) {
        if (type === 'expiratie') currentAction.max = Math.max(currentAction.max, val);
        if (type === 'inspiratie') currentAction.max = Math.min(currentAction.max, val);
    }
    // Einde actie als waarde terugkeert naar neutraal
    if (currentAction && (!type || (type !== currentAction.type))) {
        addMeasurementAction(currentAction.type, currentAction.max, (timestamp - currentAction.startTime)/1000);
        currentAction = null;
    }
}

// --- Koppel aan bestaande ademdata ---
let origHandleDeviceLine = handleDeviceLine;
handleDeviceLine = function(line) {
    origHandleDeviceLine(line);
    if (!measurementActive) return;
    if (line.startsWith('BREATH_DATA:')) {
        const val = parseFloat(line.split(':')[1]);
        const timestamp = Date.now();
        measurementData.push({val, timestamp});
        processBreathValue(val, timestamp);
    }
};

startBtn.addEventListener('click', () => {
    resetMeasurement();
    measurementActive = true;
    measurementType = document.getElementById('measurementType').value;
    // Datum standaard op vandaag als leeg
    const dateInput = document.getElementById('measurementDate');
    if (!dateInput.value) {
        const today = new Date();
        dateInput.value = today.toISOString().split('T')[0];
    }
    startBtn.disabled = true;
    stopBtn.disabled = false;
    exportBtn.disabled = true;
});

stopBtn.addEventListener('click', () => {
    measurementActive = false;
    if (currentAction) {
        // Sluit laatste actie af
        addMeasurementAction(currentAction.type, currentAction.max, (Date.now() - currentAction.startTime)/1000);
        currentAction = null;
    }
    startBtn.disabled = false;
    stopBtn.disabled = true;
    exportBtn.disabled = false;
    // Toon samenvatting
    let nExp = measurementActions.filter(a=>a.type==='expiratie').length;
    let nIns = measurementActions.filter(a=>a.type==='inspiratie').length;
    let avgDurExp = nExp ? (measurementActions.filter(a=>a.type==='expiratie').reduce((s,a)=>s+a.duration,0)/nExp).toFixed(2) : '-';
    let avgDurIns = nIns ? (measurementActions.filter(a=>a.type==='inspirie').reduce((s,a)=>s+a.duration,0)/nIns).toFixed(2) : '-';
    let avgMaxExp = nExp ? (measurementActions.filter(a=>a.type==='expiratie').reduce((s,a)=>s+a.max,0)/nExp).toFixed(3) : '-';
    let avgMaxIns = nIns ? (measurementActions.filter(a=>a.type==='inspirie').reduce((s,a)=>s+a.max,0)/nIns).toFixed(3) : '-';
    summaryDiv.innerHTML = `<b>Samenvatting:</b><br>
        Aantal expiraties: ${nExp}<br>
        Gem. duur expiratie: ${avgDurExp} s<br>
        Gem. max expiratie: ${avgMaxExp}<br>
        Aantal inspiraties: ${nIns}<br>
        Gem. duur inspiratie: ${avgDurIns} s<br>
        Gem. max inspiratie: ${avgMaxIns}`;
});

exportBtn.disabled = true;
stopBtn.disabled = true;

// PDF-export functie
exportBtn.addEventListener('click', async () => {
    // jsPDF laden indien nodig
    if (typeof window.jspdf === 'undefined' && typeof window.jsPDF === 'undefined') {
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
        document.head.appendChild(script);
        await new Promise(resolve => { script.onload = resolve; });
    }
    const { jsPDF } = window.jspdf || window;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
    const meta = getMeasurementMeta();
    let y = 54;
    const left = 40;
    const colW = 180;
    const kleur = '#062d36';
    // Titel
    doc.setFontSize(28);
    doc.setTextColor(kleur);
    doc.setFont(undefined, 'bold');
    doc.text('Ademmeting Rapport', left, y);
    y += 12;
    // Exportdatum/tijd klein rechtsboven
    const now = new Date();
    const exportDate = now.toISOString().split('T')[0];
    const exportTime = now.toTimeString().slice(0,5);
    doc.setFontSize(10);
    doc.setTextColor(80,80,80);
    doc.text(`Export: ${exportDate} ${exportTime}`, 700, 40, {align:'right'});
    y += 18;
    // Metadata in 1 rij
    doc.setFontSize(12);
    doc.setTextColor(kleur);
    doc.setFont(undefined, 'normal');
    doc.text(`Naam: ${meta.name || '-'}`, left, y);
    doc.text(`Datum: ${meta.date || '-'}`, left+colW, y);
    doc.text(`Diameter PEP-dopje: ${meta.diameter || '-'}`, left+colW*2, y);
    doc.text(`Testtype: ${meta.type.charAt(0).toUpperCase()+meta.type.slice(1)}`, left+colW*3, y);
    y += 18;
    // Lijn
    doc.setDrawColor(220,220,220);
    doc.setLineWidth(1);
    doc.line(left, y, 780, y);
    y += 16;
    // Samenvatting in 2 kolommen
    let nExp = measurementActions.filter(a=>a.type==='expiratie').length;
    let nIns = measurementActions.filter(a=>a.type==='inspirie').length;
    let avgDurExp = nExp ? (measurementActions.filter(a=>a.type==='expiratie').reduce((s,a)=>s+a.duration,0)/nExp).toFixed(2) : '-';
    let avgDurIns = nIns ? (measurementActions.filter(a=>a.type==='inspirie').reduce((s,a)=>s+a.duration,0)/nIns).toFixed(2) : '-';
    let avgMaxExp = nExp ? (measurementActions.filter(a=>a.type==='expiratie').reduce((s,a)=>s+a.max,0)/nExp).toFixed(3) : '-';
    let avgMaxIns = nIns ? (measurementActions.filter(a=>a.type==='inspirie').reduce((s,a)=>s+a.max,0)/nIns).toFixed(3) : '-';
    doc.setFontSize(12);
    doc.setTextColor(kleur);
    doc.setFont(undefined, 'bold');
    doc.text('Aantal expiraties:', left, y); doc.setFont(undefined, 'normal'); doc.text(`${nExp}`, left+110, y);
    doc.setFont(undefined, 'bold');
    doc.text('Gem. duur expiratie:', left+colW, y); doc.setFont(undefined, 'normal'); doc.text(`${avgDurExp} s`, left+colW+120, y);
    doc.setFont(undefined, 'bold');
    doc.text('Gem. max expiratie:', left+colW*2, y); doc.setFont(undefined, 'normal'); doc.text(`${avgMaxExp}`, left+colW*2+120, y);
    y += 16;
    doc.setFont(undefined, 'bold');
    doc.text('Aantal inspiraties:', left, y); doc.setFont(undefined, 'normal'); doc.text(`${nIns}`, left+110, y);
    doc.setFont(undefined, 'bold');
    doc.text('Gem. duur inspiratie:', left+colW, y); doc.setFont(undefined, 'normal'); doc.text(`${avgDurIns} s`, left+colW+120, y);
    doc.setFont(undefined, 'bold');
    doc.text('Gem. max inspiratie:', left+colW*2, y); doc.setFont(undefined, 'normal'); doc.text(`${avgMaxIns}`, left+colW*2+120, y);
    y += 18;
    // Lijn
    doc.setDrawColor(220,220,220);
    doc.setLineWidth(1);
    doc.line(left, y, 780, y);
    y += 16;
    // Chart.js grafiek als afbeelding
    if (measurementChart) {
        const chartImg = measurementChart.toBase64Image();
        doc.addImage(chartImg, 'PNG', left, y, 500, 200);
        y += 210;
    }
    // Lijn
    doc.setDrawColor(220,220,220);
    doc.setLineWidth(1);
    doc.line(left, y, 780, y);
    y += 16;
    // Tabel
    doc.setFontSize(12);
    doc.setTextColor(kleur);
    doc.setFont(undefined, 'bold');
    doc.text('Resultaten:', left, y);
    y += 14;
    // Tabelkop
    doc.setFillColor(245,245,245);
    doc.rect(left, y-10, 700, 18, 'F');
    doc.setTextColor(kleur);
    doc.text('#', left+10, y);
    doc.text('Type', left+50, y);
    doc.text('Maximale waarde', left+160, y);
    doc.text('Duur (s)', left+320, y);
    y += 10;
    // Tabelrijen
    doc.setFont(undefined, 'normal');
    measurementActions.forEach((a,i) => {
        // Afwisselend lichte rijen
        if (i%2===1) { doc.setFillColor(250,250,250); doc.rect(left, y, 700, 18, 'F'); }
        // Typekleur
        let kleurType = a.type === 'inspiratie' ? '#1976d2' : '#f57c00';
        doc.setTextColor(kleurType);
        doc.text(`${i+1}`, left+10, y+12);
        doc.text(a.type.charAt(0).toUpperCase()+a.type.slice(1), left+50, y+12);
        doc.setTextColor(kleur);
        doc.text(a.max.toFixed(3), left+160, y+12);
        doc.text(a.duration.toFixed(2), left+320, y+12);
        y += 18;
    });
    // Lijn
    y += 2;
    doc.setDrawColor(220,220,220);
    doc.setLineWidth(1);
    doc.line(left, y, 780, y);
    // Voettekst
    doc.setFontSize(9);
    doc.setTextColor(120,120,120);
    doc.text(`Export: ${exportDate} ${exportTime}`, 780, 570, {align:'right'});
    // Bestandsnaam: Naam_Datum_Tijd_Testtype.pdf
    const safeName = (meta.name||'onbekend').replace(/[^a-zA-Z0-9_\-]/g,'_');
    const safeType = (meta.type||'').replace(/[^a-zA-Z0-9_\-]/g,'_');
    doc.save(`${safeName}_${meta.date||exportDate}_${exportTime.replace(':','')}_${safeType}.pdf`);
});

});
