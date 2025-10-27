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
    let hasUnsavedChanges = false;
    window.lastBreathValue = 0;
    let settingsCache = {};
    
    // Debug functie
    function debugLog(message, ...args) {
        const debugCheckbox = document.getElementById('enableDebug');
        if (debugCheckbox && debugCheckbox.checked) {
            console.log(message, ...args);
        }
    }
    
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
                sendSettingUpdate({ 'inhale_gpio_threshold': val });
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
            // Update ook knoppen testbalken als we in knoppen modus zijn
            const controlMode = document.getElementById('controlMode')?.value;
            if (controlMode === 'buttons') {
                updateButtonTestbars(val);
            }
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
                updateModeCheckboxesFromSettings(json);
            } catch (e) { }
        } else if (line.startsWith('PEP VOORTGANG:')) {
            // PEP voortgang bericht verwerken
            const match = line.match(/PEP VOORTGANG: (\d+)\/(\d+) herhalingen gehaald/);
            if (match) {
                if (!window.pepProgressData) {
                    window.pepProgressData = { current: 0, total: 5 };
                }
                window.pepProgressData.current = parseInt(match[1]);
                window.pepProgressData.total = parseInt(match[2]);
                updatePepProgressCounter();
                console.log(`PEP voortgang bijgewerkt: ${match[1]}/${match[2]}`);
            }
        } else if (line.startsWith('PEP_REWARD:PLAY_MP3::')) {
            // Browser MP3 afspelen
            const mp3File = line.split('::')[1];
            if (mp3File && window.playPepRewardMp3) {
                window.playPepRewardMp3(mp3File);
            }
        } else if (line.startsWith('OK')) {
            // Generic OK, can be used for feedback
        } else if (line.startsWith('ERROR')) {
            setStatus('Fout van apparaat: ' + line, false);
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
    
    // Bij verbreken - NU MET OPSLAAN-LOGICA
    async function disconnectDevice() {
        if (hasUnsavedChanges) {
            setStatus('Instellingen worden opgeslagen, even geduld...', true, true);
        }
    
        try {
            if (reader) { await reader.cancel(); reader = null; }
            if (writer) { await writer.releaseLock(); writer = null; }
            if (port) { await port.close(); port = null; }
        } catch (e) {
            // Errors during closing are often expected if the device reboots, so we can ignore them.
        }
        
        isConnected = false;
    
        if (hasUnsavedChanges) {
            // Give the device a moment to perform the save operation after disconnect.
            setTimeout(() => {
                setStatus('Instellingen opgeslagen. Verbinding verbroken.', false);
                hasUnsavedChanges = false;
                updateUnsavedChangesIndicator();
            }, 2000); // 2 second delay for safety
        } else {
            setStatus('Niet verbonden met apparaat', false);
        }
    
        if (breathTimeoutInterval) { clearInterval(breathTimeoutInterval); breathTimeoutInterval = null; }
    }
    
    
    function setStatus(text, ok, busy = false) {
        statusDisplay.textContent = text;
        statusDisplay.className = 'status ' + (ok ? (busy ? 'adapter' : 'connected') : 'disconnected');
        connectionButton.disabled = !!ok;
        disconnectButton.disabled = !ok || busy;
    }
    
    // Toast melding functie voor backup feedback
    function showToast(message, type = 'info') {
        // Verwijder bestaande toast als die er is
        const existingToast = document.querySelector('.toast-message');
        if (existingToast) {
            existingToast.remove();
        }
        
        // Maak nieuwe toast
        const toast = document.createElement('div');
        toast.className = `toast-message toast-${type}`;
        toast.textContent = message;
        
        // Voeg CSS toe als die nog niet bestaat
        if (!document.querySelector('#toast-styles')) {
            const style = document.createElement('style');
            style.id = 'toast-styles';
            style.textContent = `
                .toast-message {
                    position: fixed;
                    top: 20px;
                    right: 20px;
                    padding: 16px 24px;
                    border-radius: 8px;
                    color: white;
                    font-weight: 500;
                    z-index: 10000;
                    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
                    animation: slideIn 0.3s ease-out;
                    max-width: 400px;
                    word-wrap: break-word;
                }
                .toast-success { background: #4caf50; }
                .toast-error { background: #f44336; }
                .toast-info { background: #2196f3; }
                .status.adapter { background-color: #fff3e0; color: #f57c00; border: 1px solid #ffe0b2; }
                @keyframes slideIn {
                    from { transform: translateX(100%); opacity: 0; }
                    to { transform: translateX(0); opacity: 1; }
                }
            `;
            document.head.appendChild(style);
        }
        
        // Voeg toast toe aan pagina
        document.body.appendChild(toast);
        
        // Verwijder toast na 5 seconden
        setTimeout(() => {
            if (toast.parentNode) {
                toast.remove();
            }
        }, 5000);
        
        // Verwijder toast bij klik
        toast.addEventListener('click', () => {
            toast.remove();
        });
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
            if (isConnected) { // Only show error if we weren't expecting a disconnect
                setStatus('Verbinding verbroken: ' + e, false);
                isConnected = false;
                connectionButton.disabled = false;
            }
        }
    }
    
    function sendCommand(cmd) {
        if (writer) {
            writer.write(new TextEncoder().encode(cmd + '\n'));
        }
    }
    
    function updateUnsavedChangesIndicator() {
        const indicator = document.getElementById('autosaveStatusText');
        if (!indicator) return;
        if (hasUnsavedChanges) {
            indicator.innerHTML = `
                <strong style="color:#f57c00;">Wijzigingen niet opgeslagen</strong>
                <div style="font-size:0.9em;color:#666;margin-top:2px;">
                    Verbreek de verbinding om de laatste wijzigingen permanent op te slaan.
                </div>`;
            indicator.previousElementSibling.style.background = '#f57c00'; // The dot
        } else {
            indicator.innerHTML = `
                <strong style="color:#28a745;">Instellingen opgeslagen</strong>
                <div style="font-size:0.9em;color:#666;margin-top:2px;">
                    Alle instellingen zijn up-to-date op het apparaat.
                </div>`;
            indicator.previousElementSibling.style.background = '#28a745';
        }
    }
    
    function sendSettingUpdate(settingObject) {
        sendCommand('SET:settings::' + JSON.stringify(settingObject));
        Object.assign(settingsCache, settingObject);
        hasUnsavedChanges = true;
        updateUnsavedChangesIndicator();
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
        
        // Deadzone slider
        if (s.deadzone !== undefined) {
            const deadzoneSlider = document.getElementById('deadzone');
            const deadzoneValue = document.getElementById('deadzoneValue');
            if (deadzoneSlider && deadzoneValue) {
                deadzoneSlider.value = s.deadzone;
                deadzoneValue.textContent = s.deadzone.toFixed(2);
            }
        }
        
        // Joystick max waarden
        if (s.joystick_inhale_max !== undefined) {
            const inhaleMaxSlider = document.getElementById('joystickInhaleMax');
            const inhaleMaxValue = document.getElementById('joystickInhaleMaxValue');
            if (inhaleMaxSlider && inhaleMaxValue) {
                inhaleMaxSlider.value = s.joystick_inhale_max;
                inhaleMaxValue.textContent = s.joystick_inhale_max.toFixed(2);
            }
        }
        if (s.joystick_exhale_max !== undefined) {
            const exhaleMaxSlider = document.getElementById('joystickExhaleMax');
            const exhaleMaxValue = document.getElementById('joystickExhaleMaxValue');
            if (exhaleMaxSlider && exhaleMaxValue) {
                exhaleMaxSlider.value = s.joystick_exhale_max;
                exhaleMaxValue.textContent = s.joystick_exhale_max.toFixed(2);
            }
        }
    }
    
    function sliderSendSetting(id, key) {
        const el = document.getElementById(id);
        const val = el.type === 'range' || el.type === 'number' ? parseFloat(el.value) : el.value;
        document.getElementById(id+'Value').textContent = val;
        sendSettingUpdate({ [key]: val });
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
        
        // Check of we in knoppen modus zijn
        const controlMode = document.getElementById('controlMode').value;
        const isButtonsMode = controlMode === 'buttons';
        
        if (isButtonsMode) {
            // In knoppen modus: toon knoppen drempels
            updateButtonTestbars(currentValue);
            // Zorg dat live dot zichtbaar blijft in knoppen modus
            if (liveDot) {
                liveDot.style.display = '';
                // Update live dot positie ook in knoppen modus
                let dotPct = ((currentValue + 1) / 2) * 100;
                liveDot.style.left = dotPct + '%';
                liveDot.textContent = currentValue.toFixed(2);
            }
            return; // Skip joystick logica
        }
        
        // Joystick modus logica
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
        // updateButtonTestbars wordt nu direct aangeroepen in handleDeviceLine
    }
    
    // Knoppen drempel testbalken logica
    function updateButtonTestbars(currentValue) {
        try {
            const debugCheckbox = document.getElementById('enableDebug');
        
        const expiratieThreshold = parseFloat(document.getElementById('expiratieThreshold').value);
        const inspiratieThreshold = parseFloat(document.getElementById('inspiratieThreshold').value);
        
        // Gebruik de knoppen testbalk (buttonsCombinedTestbar)
        const testbar = document.getElementById('buttonsCombinedTestbar');
        const exhaleMarker = document.getElementById('buttonExhaleMarker');
        const inhaleMarker = document.getElementById('buttonInhaleMarker');
        const liveDot = document.getElementById('buttonsLiveDot');
        
        if (testbar && exhaleMarker && inhaleMarker && liveDot) {
            
            // Expiratie marker (uitademen) - oranje
            let exhaleMarkerPct = ((expiratieThreshold + 1) / 2) * 100;
            exhaleMarker.style.left = exhaleMarkerPct + '%';
            exhaleMarker.style.background = '#f57c00'; // oranje
            
            // Inspiratie marker (inademen) - blauw
            let inhaleMarkerPct = ((inspiratieThreshold + 1) / 2) * 100;
            inhaleMarker.style.left = inhaleMarkerPct + '%';
            inhaleMarker.style.background = '#1976d2'; // blauw
            
            // Live dot positie - ZORG DAT DEZE ALTIJD ZICHTBAAR IS
            let dotPct = ((currentValue + 1) / 2) * 100;
            liveDot.style.left = dotPct + '%';
            liveDot.textContent = currentValue.toFixed(2);
            liveDot.style.display = ''; // Zorg dat de dot altijd zichtbaar is
            
            // Balkkleur: groen als een van de drempels wordt gehaald
            if ((currentValue >= expiratieThreshold) || (currentValue <= inspiratieThreshold)) {
                testbar.style.background = '#4caf50'; // groen
            } else {
                testbar.style.background = '#e0e0e0'; // grijs
            }
            
            // Debug output alleen als debug is ingeschakeld
            if (debugCheckbox && debugCheckbox.checked) {
                console.log(`🎯 Knoppen testbalk: breath=${currentValue.toFixed(3)}, exhale_threshold=${expiratieThreshold.toFixed(3)}, inhale_threshold=${inspiratieThreshold.toFixed(3)}, dot_position=${dotPct.toFixed(1)}%`);
            }
        } else {
            if (debugCheckbox && debugCheckbox.checked) {
                console.log(`🔧 updateButtonTestbars: HTML elementen niet gevonden!`);
            }
        }
        } catch (error) {
            console.error(`🔧 updateButtonTestbars: Fout opgetreden:`, error);
        }
    }
    
    // --- Knoppenmodus sliders functioneel maken ---
    ['expiratieThreshold','inspiratieThreshold'].forEach(id => {
        const el = document.getElementById(id);
        const valEl = document.getElementById(id+'Value');
        el.addEventListener('input',()=>{
            valEl.textContent = el.value;
            // Update testbalken
            updateButtonTestbars(window.lastBreathValue || 0);
            // Stuur direct naar device
            let key = id === 'expiratieThreshold' ? 'blow_threshold' : 'inhale_threshold';
            let val = parseFloat(el.value);
            sendSettingUpdate({ [key]: val });
        });
    });
    
    // --- PEP modus sliders functioneel maken ---
    ['pepTarget','pepSuccessTime','pepStartBrightness','pepMaxBrightness','pepBlinkCount','pepBlinkSpeed'].forEach(id => {
        const el = document.getElementById(id);
        const valEl = document.getElementById(id+'Value');
        if (el && valEl) {
            el.addEventListener('input',()=>{
                valEl.textContent = el.value;
                // Direct naar device sturen (key = id in snake_case)
                let key = id.replace(/[A-Z]/g, m => '_' + m.toLowerCase());
                let val = el.type === 'range' || el.type === 'number' ? parseFloat(el.value) : el.value;
                sendSettingUpdate({ [key]: val });
            });
        }
    });
    
    // Value-displays voor PEP beloning sliders
    ['pepRewardMp3Volume','pepRewardLedBrightness','pepRewardGpioDuration'].forEach(id => {
        const el = document.getElementById(id);
        const valEl = document.getElementById(id+'Value');
        if (el && valEl) {
            el.addEventListener('input',()=>{ valEl.textContent = el.value; });
        }
    });
    
    // Beloningstype logica
    const pepRewardType = document.getElementById('pepRewardType');
    const pepRewardMp3Settings = document.getElementById('pepRewardMp3Settings');
    const pepRewardBrowserMp3Settings = document.getElementById('pepRewardBrowserMp3Settings');
    const pepRewardLedSettings = document.getElementById('pepRewardLedSettings');
    const pepRewardGpioSettings = document.getElementById('pepRewardGpioSettings');
    function updatePepRewardSettingsVisibility() {
        pepRewardMp3Settings.style.display = pepRewardType.value === 'mp3' ? '' : 'none';
        pepRewardBrowserMp3Settings.style.display = pepRewardType.value === 'browser_mp3' ? '' : 'none';
        pepRewardLedSettings.style.display = pepRewardType.value === 'led' ? '' : 'none';
        pepRewardGpioSettings.style.display = pepRewardType.value === 'gpio' ? '' : 'none';
    }
    pepRewardType.addEventListener('change', updatePepRewardSettingsVisibility);
    updatePepRewardSettingsVisibility();
    
    // --- Knoppen dropdowns functioneel maken ---
    ['expiratieButton', 'inspiratieButton'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('change', () => {
                let key = id === 'expiratieButton' ? 'blow_button' : 'inhale_button';
                let val = el.value === 'none' ? 'none' : parseInt(el.value);
                sendSettingUpdate({ [key]: val });
                // Debug logging alleen als debug is ingeschakeld
                const debugCheckbox = document.getElementById('enableDebug');
                if (debugCheckbox && debugCheckbox.checked) {
                    console.log(`🔧 ${key} bijgewerkt naar:`, val);
                }
            });
        }
    });
    
    // --- Init ---
    setStatus('Niet verbonden met apparaat', false);
    
    // Zet event listeners voor verbind- en disconnectknop als laatste
    // Moderne event listener voor verbind knop
    if (connectionButton) {
        connectionButton.addEventListener('click', connectDevice);
    }
    if (disconnectButton) {
        disconnectButton.addEventListener('click', disconnectDevice);
    }
    
    // Toon alleen de juiste controls bij Besturingsmodus
    const controlModeSelect = document.getElementById('controlMode');
    const joystickControls = document.getElementById('joystickControls');
    const buttonControls = document.getElementById('buttonControls');
    function updateControlModeUI() {
        const joystickTestSection = document.getElementById('joystickTestSection');
        const exhaleMarker = document.getElementById('buttonExhaleMarker');
        const inhaleMarker = document.getElementById('buttonInhaleMarker');
        const joystickLiveDot = document.getElementById('joystickLiveDot');
        const buttonsLiveDot = document.getElementById('buttonsLiveDot');
        
        if (controlModeSelect.value === 'joystick') {
            joystickControls.style.display = '';
            buttonControls.style.display = 'none';
            if (joystickTestSection) joystickTestSection.style.display = '';
            // Verberg knoppen markers in joystick modus
            if (exhaleMarker) exhaleMarker.style.display = 'none';
            if (inhaleMarker) inhaleMarker.style.display = 'none';
            // Zorg dat joystick live dot zichtbaar blijft
            if (joystickLiveDot) joystickLiveDot.style.display = '';
            if (buttonsLiveDot) buttonsLiveDot.style.display = 'none';
        } else {
            joystickControls.style.display = 'none';
            buttonControls.style.display = '';
            if (joystickTestSection) joystickTestSection.style.display = 'none';
            // Toon knoppen markers in knoppen modus
            if (exhaleMarker) exhaleMarker.style.display = '';
            if (inhaleMarker) inhaleMarker.style.display = '';
            // Zorg dat knoppen live dot zichtbaar blijft
            if (joystickLiveDot) joystickLiveDot.style.display = 'none';
            if (buttonsLiveDot) buttonsLiveDot.style.display = '';
            
            // Update knoppen testbalken wanneer naar knoppen modus wordt gewisseld
            if (window.lastBreathValue !== undefined) {
                updateButtonTestbars(window.lastBreathValue);
            }
        }
    }
    controlModeSelect.addEventListener('change', () => {
        const mode = controlModeSelect.value;
        sendSettingUpdate({ 'control_mode': mode });
        updateControlModeUI();
        
        // Debug: Toon huidige instellingen voor knoppen modus
        const debugCheckbox = document.getElementById('enableDebug');
        if (mode === 'buttons' && debugCheckbox && debugCheckbox.checked) {
            console.log('🔧 Knoppen modus instellingen:');
            console.log('  - Expiratie knop:', document.getElementById('expiratieButton').value);
            console.log('  - Inspiratie knop:', document.getElementById('inspiratieButton').value);
            console.log('  - Expiratie drempel:', document.getElementById('expiratieThreshold').value);
            console.log('  - Inspiratie drempel:', document.getElementById('inspiratieThreshold').value);
        }
    });
    updateControlModeUI();
    
    // Zorg ervoor dat de UI correct wordt getoond bij het laden
    setTimeout(() => {
        updateControlModeUI();
        // Initialiseer knoppen testbalken
        if (window.lastBreathValue !== undefined) {
            updateButtonTestbars(window.lastBreathValue);
        }
        
        // Test de verbind knop
        console.log('Verbind knop test:', connectionButton);
        console.log('Disconnect knop test:', disconnectButton);
        
        // Controleer of de knoppen bestaan en voeg event listeners toe als ze nog niet bestaan
        if (connectionButton && !connectionButton.onclick) {
            connectionButton.addEventListener('click', connectDevice);
            console.log('Verbind knop event listener toegevoegd');
        }
        if (disconnectButton && !disconnectButton.onclick) {
            disconnectButton.addEventListener('click', disconnectDevice);
            console.log('Disconnect knop event listener toegevoegd');
        }
    }, 100);
    
    // Extra check voor DOM ready
    document.addEventListener('DOMContentLoaded', () => {
        console.log('DOM geladen, controleer knoppen...');
        if (connectionButton) {
            console.log('Verbind knop gevonden, voeg event listener toe');
            connectionButton.addEventListener('click', connectDevice);
        } else {
            console.log('Verbind knop NIET gevonden!');
        }
        if (disconnectButton) {
            console.log('Disconnect knop gevonden, voeg event listener toe');
            disconnectButton.addEventListener('click', disconnectDevice);
        } else {
            console.log('Disconnect knop NIET gevonden!');
        }
    });
    
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
    
    function updateMeasurementCounters() {
        const nExp = measurementActions.filter(a=>a.type==='expiratie').length;
        const nIns = measurementActions.filter(a=>a.type==='inspiratie').length;
        document.getElementById('expCounter').textContent = nExp;
        document.getElementById('insCounter').textContent = nIns;
    }
    
    function resetMeasurement() {
        measurementData = [];
        measurementActions = [];
        measurementActionNr = 1;
        tableDiv.innerHTML = '';
        summaryDiv.innerHTML = '';
        if (measurementChart) measurementChart.destroy();
        measurementChart = null;
        updateMeasurementCounters();
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
        const chartType = document.getElementById('chartType').value;
        const labels = measurementActions.map((a,i) => `${a.type.charAt(0).toUpperCase()}${a.type.slice(1)} ${i+1}`);
        
        let dataInspiratie, dataExpiratie, yAxisLabel, yAxisConfig;
        
        if (chartType === 'duration') {
            // Duur grafiek: Y-as toont de duur in seconden
            dataInspiratie = measurementActions.map(a => a.type === 'inspiratie' ? a.duration : null);
            dataExpiratie = measurementActions.map(a => a.type === 'expiratie' ? a.duration : null);
            yAxisLabel = 'Duur (seconden)';
            yAxisConfig = {
                beginAtZero: true,
                title: {
                    display: true,
                    text: yAxisLabel
                }
            };
        } else {
            // Waarden grafiek: Y-as toont de ademhalingswaarden (origineel gedrag)
            dataInspiratie = measurementActions.map(a => a.type === 'inspiratie' ? a.max : null);
            dataExpiratie = measurementActions.map(a => a.type === 'expiratie' ? a.max : null);
            yAxisLabel = 'Ademhalingswaarde';
            yAxisConfig = {
                beginAtZero: true,
                title: {
                    display: true,
                    text: yAxisLabel
                }
            };
        }
        
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
                    x: { 
                        stacked: true,
                        title: {
                            display: true,
                            text: 'Ademhalingsacties'
                        }
                    },
                    y: yAxisConfig
                }
            }
        });
    }
    
    function addMeasurementAction(type, max, duration) {
        measurementActions.push({type, max, duration});
        renderMeasurementTable();
        renderMeasurementChart();
        updateMeasurementCounters();
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
        // Toon direct een lege grafiek
        renderMeasurementChart();
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
        let avgDurIns = nIns ? (measurementActions.filter(a=>a.type==='inspiratie').reduce((s,a)=>s+a.duration,0)/nIns).toFixed(2) : '-';
        let avgMaxExp = nExp ? (measurementActions.filter(a=>a.type==='expiratie').reduce((s,a)=>s+a.max,0)/nExp).toFixed(3) : '-';
        let avgMaxIns = nIns ? (measurementActions.filter(a=>a.type==='inspiratie').reduce((s,a)=>s+Math.abs(a.max),0)/nIns).toFixed(3) : '-';
        summaryDiv.innerHTML = `<b>Samenvatting:</b><br>
            Aantal expiraties: ${nExp}<br>
            Gem. duur expiratie: ${avgDurExp} s<br>
            Gem. max expiratie: ${avgMaxExp}<br>
            Aantal inspiraties: ${nIns}<br>
            Gem. duur inspiratie: ${avgDurIns} s<br>
            Gem. max inspiratie: ${avgMaxIns}`;
        updateMeasurementCounters();
    });
    
    exportBtn.disabled = true;
    stopBtn.disabled = true;
    
    // Event listener voor grafiek type selector
    const chartTypeSelect = document.getElementById('chartType');
    chartTypeSelect.addEventListener('change', () => {
        // Herteken de grafiek wanneer het type wordt gewijzigd
        if (measurementActions.length > 0) {
            renderMeasurementChart();
        }
    });
    
    // --- Testmodus dropdown en instellingen tonen ---
    const testModeSelect = document.getElementById('testModeSelect');
    const testModeSettings = document.getElementById('testModeSettings');
    const testRemarks = document.getElementById('testRemarks');
    let selectedTestMode = 'free';
    
    testModeSelect.addEventListener('change', () => {
        selectedTestMode = testModeSelect.value;
        renderTestModeSettings();
        // Toon kleurkiezer alleen bij LED Spel
        document.getElementById('ledStartColorWrap').style.display = (selectedTestMode === 'led') ? '' : 'none';
    });
    
    function renderTestModeSettings() {
        let html = '';
        const s = collectSettingsFromUI();
        if (selectedTestMode === 'gpio') {
            html = `<b>3,5mm Output instellingen:</b><br>Drempel inspiratie: <b>${s.inhale_gpio_threshold}</b><br>Drempel expiratie: <b>${s.blow_gpio_threshold}</b><br>Hold tijd: <b>${s.gpio_duration} ms</b>`;
        } else if (selectedTestMode === 'joystick') {
            html = `<b>Joystick/Gamepad instellingen:</b><br>Max inademen: <b>${s.joystick_inhale_max}</b><br>Max uitademen: <b>${s.joystick_exhale_max}</b><br>Deadzone: <b>${s.deadzone}</b>`;
        } else if (selectedTestMode === 'pep') {
            html = `<b>PEP Modus instellingen:</b><br>Doelwaarde: <b>${s.pep_target_value}</b><br>Succes tijd: <b>${s.pep_hold_time}</b> sec<br>Herhalingen: <b>${s.pep_repeat_count}</b><br><br><b>Huidige voortgang:</b><br><div style="display:flex;align-items:center;gap:12px;margin-top:8px;"><span style="font-size:1.2em;font-weight:bold;color:#4caf50;">Herhalingen: <span id="pepProgressCounter">0</span>/${s.pep_repeat_count}</span><button class="material-btn" id="pepResetBtn" style="padding:4px 8px;font-size:0.9em;">Reset</button></div>`;
        } else if (selectedTestMode === 'mp3') {
            html = `<b>MP3 Speler instellingen:</b><br>Min. volume: <b>${s.min_volume}</b><br>Max. volume: <b>${s.max_volume}</b><br>Gevoeligheid: <b>${s.mp3_sensitivity}</b>`;
        } else if (selectedTestMode === 'led') {
            html = `<b>Interactief LED Spel instellingen:</b><br>Start helderheid: <b>${s.led_start_brightness*100}%</b><br>Max helderheid: <b>${s.led_max_brightness*100}%</b>`;
        } else {
            html = `<i>Vrije meting: alleen registratie van ademwaarden.</i>`;
        }
        testModeSettings.innerHTML = html;
    }
    renderTestModeSettings();
    
    // === PEP Modus Voortgang Functionaliteit ===
    // PEP voortgang teller bijwerken
    function updatePepProgressCounter() {
        const counter = document.getElementById('pepProgressCounter');
        if (counter && window.pepProgressData) {
            counter.textContent = window.pepProgressData.current;
            console.log(`PEP counter UI bijgewerkt naar: ${window.pepProgressData.current}/${window.pepProgressData.total}`);
        }
    }
    
    // PEP voortgang resetten
    function resetPepProgress() {
        if (window.pepProgressData) {
            window.pepProgressData.current = 0;
            updatePepProgressCounter();
            const debugCheckbox = document.getElementById('enableDebug');
        if (debugCheckbox && debugCheckbox.checked) {
            console.log('PEP voortgang gereset');
        }
        }
    }
    
    // PEP reset knop event listener
    document.addEventListener('click', (e) => {
        if (e.target && e.target.id === 'pepResetBtn') {
            resetPepProgress();
        }
    });
    
    // PEP voortgang data object
    window.pepProgressData = { current: 0, total: 5 };
    
    // Browser MP3 afspelen functie
    window.playPepRewardMp3 = function(mp3File) {
        try {
            const audio = new Audio(mp3File);
            audio.volume = 0.8;
            audio.play().then(() => {
                const debugCheckbox = document.getElementById('enableDebug');
        if (debugCheckbox && debugCheckbox.checked) {
            console.log(`🎵 Browser MP3 afgespeeld: ${mp3File}`);
        }
            }).catch(e => {
                console.error(`❌ Fout bij afspelen MP3: ${e}`);
            });
        } catch (e) {
            console.error(`❌ Fout bij maken audio object: ${e}`);
        }
    };
    
    // --- PDF-export aanpassen ---
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
        doc.text(`Export: ${exportDate} ${exportTime}`, 780, 40, {align:'right'});
        y += 18;
        // Metadata in 1 nette rij
        doc.setFontSize(13);
        doc.setTextColor(kleur);
        doc.setFont(undefined, 'normal');
        doc.text(`Naam: ${meta.name || '-'}`, left, y);
        doc.text(`Datum: ${meta.date || '-'}`, left+160, y);
        doc.text(`Diameter PEP-dopje: ${meta.diameter || '-'}`, left+320, y);
        doc.text(`Testtype: ${meta.type.charAt(0).toUpperCase()+meta.type.slice(1)}`, left+480, y);
        y += 16;
        // Test/spelmodus direct onder metadata
        doc.setFontSize(13);
        doc.setTextColor(kleur);
        doc.setFont(undefined, 'bold');
        doc.text(`Test/spelmodus: ${testModeSelect.options[testModeSelect.selectedIndex].text}`, left, y);
        y += 16;
        // Lijn
        doc.setDrawColor(220,220,220);
        doc.setLineWidth(1);
        doc.line(left, y, 780, y);
        y += 10;
        // Samenvatting blok (verticaal centreren tussen de lijnen)
        // Berekeningen
        const exp = measurementActions.filter(a=>a.type==='expiratie');
        const insp = measurementActions.filter(a=>a.type==='inspiratie');
        const gemExpDuur = (exp.reduce((s,a)=>s+a.duration,0)/(exp.length||1)).toFixed(2);
        const gemExpWaarde = (exp.reduce((s,a)=>s+a.max,0)/(exp.length||1)).toFixed(3);
        const maxExpWaarde = exp.length ? Math.max(...exp.map(a=>a.max)).toFixed(3) : '-';
        const maxExpDuur = exp.length ? Math.max(...exp.map(a=>a.duration)).toFixed(2) : '-';
        const gemInspDuur = (insp.reduce((s,a)=>s+a.duration,0)/(insp.length||1)).toFixed(2);
        const gemInspWaarde = (insp.reduce((s,a)=>s+a.max,0)/(insp.length||1)).toFixed(3);
        const maxInspWaarde = insp.length ? Math.max(...insp.map(a=>Math.abs(a.max))).toFixed(3) : '-';
        const maxInspDuur = insp.length ? Math.max(...insp.map(a=>a.duration)).toFixed(2) : '-';
        // Layout
        doc.setFontSize(12);
        doc.setTextColor(kleur);
        doc.setFont(undefined, 'bold');
        // Verticaal centreren tussen de lijnen
        const blokHoogte = 5 * 18; // 5 rijen, 18pt per rij
        const blokTop = y;
        const blokBottom = y + 120; // ruimte tot de volgende lijn (kan aangepast worden)
        const blokMidden = (blokTop + blokBottom) / 2;
        const summaryY = blokMidden - (blokHoogte / 2) + 12; // +12 voor optisch midden
        const summaryX1 = left;
        const summaryX2 = left+260;
        let rowH = 18;
        // Kolom 1
        doc.text('Aantal expiraties:', summaryX1, summaryY); doc.setFont(undefined, 'normal'); doc.text(`${exp.length}`, summaryX1+160, summaryY);
        doc.setFont(undefined, 'bold');
        doc.text('Gem. duur expiraties:', summaryX1, summaryY+rowH); doc.setFont(undefined, 'normal'); doc.text(`${gemExpDuur} s`, summaryX1+160, summaryY+rowH);
        doc.setFont(undefined, 'bold');
        doc.text('Gem. waarde expiraties:', summaryX1, summaryY+rowH*2); doc.setFont(undefined, 'normal'); doc.text(`${gemExpWaarde}`, summaryX1+160, summaryY+rowH*2);
        doc.setFont(undefined, 'bold');
        doc.text('Max. waarde expiratie:', summaryX1, summaryY+rowH*3); doc.setFont(undefined, 'normal'); doc.text(`${maxExpWaarde}`, summaryX1+160, summaryY+rowH*3);
        doc.setFont(undefined, 'bold');
        doc.text('Max. duur expiratie:', summaryX1, summaryY+rowH*4); doc.setFont(undefined, 'normal'); doc.text(`${maxExpDuur} s`, summaryX1+160, summaryY+rowH*4);
        // Kolom 2
        doc.setFont(undefined, 'bold');
        doc.text('Aantal inspiraties:', summaryX2, summaryY); doc.setFont(undefined, 'normal'); doc.text(`${insp.length}`, summaryX2+160, summaryY);
        doc.setFont(undefined, 'bold');
        doc.text('Gem. duur inspiraties:', summaryX2, summaryY+rowH); doc.setFont(undefined, 'normal'); doc.text(`${gemInspDuur} s`, summaryX2+160, summaryY+rowH);
        doc.setFont(undefined, 'bold');
        doc.text('Gem. waarde inspiraties:', summaryX2, summaryY+rowH*2); doc.setFont(undefined, 'normal'); doc.text(`${gemInspWaarde}`, summaryX2+160, summaryY+rowH*2);
        doc.setFont(undefined, 'bold');
        doc.text('Max. waarde inspiratie:', summaryX2, summaryY+rowH*3); doc.setFont(undefined, 'normal'); doc.text(`${maxInspWaarde}`, summaryX2+160, summaryY+rowH*3);
        doc.setFont(undefined, 'bold');
        doc.text('Max. duur inspiratie:', summaryX2, summaryY+rowH*4); doc.setFont(undefined, 'normal'); doc.text(`${maxInspDuur} s`, summaryX2+160, summaryY+rowH*4);
        y = blokBottom + 8;
        // Lijn
        doc.setDrawColor(220,220,220);
        doc.setLineWidth(1);
        doc.line(left, y, 780, y);
        y += 10;
        // Chart.js grafiek als afbeelding (hoge resolutie)
        if (measurementChart) {
            const chartImg = measurementChart.toBase64Image('image/png', 2); // 2x resolutie
            doc.addImage(chartImg, 'PNG', left, y, 650, 260);
            y += 270;
        }
        // Lijn
        doc.setDrawColor(220,220,220);
        doc.setLineWidth(1);
        doc.line(left, y, 780, y);
        y += 10;
        // Opmerkingen
        if (testRemarks.value && testRemarks.value.trim().length > 0) {
            doc.setFont(undefined, 'bold');
            doc.setFontSize(12);
            doc.setTextColor(kleur);
            doc.text('Opmerkingen:', left, y);
            y += 14;
            doc.setFont(undefined, 'normal');
            doc.setFontSize(11);
            doc.setTextColor(80,80,80);
            let remarksLines = doc.splitTextToSize(testRemarks.value, 700);
            doc.text(remarksLines, left, y);
            y += remarksLines.length * 14;
        }
        // Nieuwe pagina voor tabel
        doc.addPage();
        y = 54;
        // Tabel in 2 kolommen van elk maximaal 25 regels per pagina
        const maxRowsPerCol = 25;
        const maxRowsPerPage = 50;
        let pageRowIdx = 0;
        let colX = [left, left+370];
        let rowHeight = 18;
        let tableY = [y, y];
        let col = 0;
        let pageIdx = 0;
        const colW = 340;
        function drawTableHeader(colIdx, yPos) {
            doc.setFont(undefined, 'bold');
            doc.setFillColor(245,245,245);
            doc.rect(colX[colIdx], yPos-10, colW, 18, 'F');
            doc.setTextColor(kleur);
            doc.text('#', colX[colIdx]+10, yPos);
            doc.text('Type', colX[colIdx]+40, yPos);
            doc.text('Max waarde', colX[colIdx]+120, yPos);
            doc.text('Duur (s)', colX[colIdx]+220, yPos);
        }
        drawTableHeader(0, tableY[0]);
        drawTableHeader(1, tableY[1]);
        tableY[0] += 10;
        tableY[1] += 10;
        measurementActions.forEach((a,i) => {
            col = Math.floor((pageRowIdx % maxRowsPerPage) / maxRowsPerCol);
            let rowIdx = (pageRowIdx % maxRowsPerCol);
            let yPos = tableY[col] + rowIdx*rowHeight;
            if (rowIdx === 0 && pageRowIdx > 0) {
                // Nieuwe kolom of nieuwe pagina
                if (col === 0) {
                    doc.addPage();
                    tableY = [54, 54];
                    drawTableHeader(0, tableY[0]);
                    drawTableHeader(1, tableY[1]);
                    tableY[0] += 10;
                    tableY[1] += 10;
                }
            }
            if (i%2===1) { doc.setFillColor(250,250,250); doc.rect(colX[col], yPos, colW, rowHeight, 'F'); }
            let kleurType = a.type === 'inspiratie' ? '#1976d2' : '#f57c00';
            doc.setTextColor(kleurType);
            doc.text(`${i+1}`, colX[col]+10, yPos+12);
            doc.text(a.type.charAt(0).toUpperCase()+a.type.slice(1), colX[col]+40, yPos+12);
            doc.setTextColor(kleur);
            doc.text(a.max.toFixed(3), colX[col]+120, yPos+12);
            doc.text(a.duration.toFixed(2), colX[col]+220, yPos+12);
            if (rowIdx === maxRowsPerCol-1) tableY[col] += maxRowsPerCol*rowHeight+10;
            pageRowIdx++;
        });
        // Voettekst
        doc.setFontSize(9);
        doc.setTextColor(120,120,120);
        doc.text(`Export: ${exportDate} ${exportTime}`, 780, 570, {align:'right'});
        // Bestandsnaam: Naam_Datum_Tijd_Testtype.pdf
        const safeName = (meta.name||'onbekend').replace(/[^a-zA-Z0-9_\-]/g,'_');
        const safeType = (meta.type||'').replace(/[^a-zA-Z0-9_\-]/g,'_');
        doc.save(`${safeName}_${meta.date||exportDate}_${exportTime.replace(':','')}_${safeType}.pdf`);
    });
    
    // === Instellingen exporteren/importeren ===
    const exportSettingsBtn = document.getElementById('exportSettings');
    const importSettingsBtn = document.getElementById('importSettings');
    const settingsExportTextarea = document.getElementById('settingsExport');
    
    function collectSettingsFromUI() {
        // Verzamel alle relevante instellingen uit de UI met de juiste keys voor het device
        const settings = {
            // Debug
            debug_enabled: document.getElementById('enableDebug') ? document.getElementById('enableDebug').checked : false,
            // Joystick/Gamepad
            joystick_mode_enabled: document.getElementById('enableJoystick').checked,
            joystick_inhale_max: parseFloat(document.getElementById('joystickInhaleMax').value),
            joystick_exhale_max: parseFloat(document.getElementById('joystickExhaleMax').value),
            control_mode: document.getElementById('controlMode').value,
            deadzone: parseFloat(document.getElementById('deadzone').value),
            blow_direction: document.getElementById('blowDirection').value,
            inhale_direction: document.getElementById('inhaleDirection').value,
            blow_button: document.getElementById('expiratieButton').value,
            inhale_button: document.getElementById('inspiratieButton').value,
            blow_threshold: parseFloat(document.getElementById('expiratieThreshold').value),
            inhale_threshold: parseFloat(document.getElementById('inspiratieThreshold').value),
            // GPIO
            gpio_mode_enabled: document.getElementById('enableGPIO').checked,
            blow_gpio_threshold: parseFloat(document.getElementById('gpioExhaleThreshold').value),
            inhale_gpio_threshold: parseFloat(document.getElementById('gpioInhaleThreshold').value),
            gpio_duration: parseInt(document.getElementById('gpioDuration').value),
            // LED Ring
            led_start_brightness: parseInt(document.getElementById('ledStartBrightness').value) / 100,
            led_max_brightness: parseInt(document.getElementById('ledMaxBrightness').value) / 100,
            led_color_mode: document.getElementById('ledColorMode').value,
            led_single_color: document.getElementById('ledSingleColor') ? hexToRgb(document.getElementById('ledSingleColor').value) : [255,0,0],
            // PEP Modus
            pep_mode_enabled: document.getElementById('enablePEP').checked,
            pep_target_value: parseFloat(document.getElementById('pepTarget').value),
            pep_hold_time: parseFloat(document.getElementById('pepSuccessTime').value),
            pep_start_brightness: parseInt(document.getElementById('pepStartBrightness').value) / 100,
            pep_max_brightness: parseInt(document.getElementById('pepMaxBrightness').value) / 100,
            pep_blink_times: parseInt(document.getElementById('pepBlinkCount').value),
            pep_blink_speed: parseFloat(document.getElementById('pepBlinkSpeed').value),
            pep_repeat_count: parseInt(document.getElementById('pepRepeatCount').value),
            // MP3 Speler
            dfplayer_enabled: document.getElementById('enableMP3').checked,
            min_volume: parseInt(document.getElementById('mp3MinVolume').value),
            max_volume: parseInt(document.getElementById('mp3MaxVolume').value),
            mp3_sensitivity: parseFloat(document.getElementById('mp3Sensitivity').value),
            track_change_threshold: parseFloat(document.getElementById('mp3InhaleNextThreshold').value),
            // PEP Beloning
            pep_reward_type: document.getElementById('pepRewardType').value,
            pep_reward_mp3_track: pepRewardType.value === 'mp3' ? parseInt(document.getElementById('pepRewardMp3Track').value) : 0,
            pep_reward_mp3_volume: pepRewardType.value === 'mp3' ? parseInt(document.getElementById('pepRewardMp3Volume').value) : 0,
            pep_reward_led_effect: pepRewardType.value === 'led' ? document.getElementById('pepRewardLedEffect').value : '',
            pep_reward_led_brightness: pepRewardType.value === 'led' ? parseInt(document.getElementById('pepRewardLedBrightness').value) / 100 : 0,
            pep_reward_gpio_duration: pepRewardType.value === 'gpio' ? parseInt(document.getElementById('pepRewardGpioDuration').value) : 0,
            pep_reward_browser_mp3: document.getElementById('pepRewardBrowserMp3') ? document.getElementById('pepRewardBrowserMp3').value : "muziek/applaus.mp3",
        };
        return settings;
    }
    
    function hexToRgb(hex) {
        // Converteer #rrggbb naar [r,g,b]
        hex = hex.replace('#','');
        return [parseInt(hex.substring(0,2),16),parseInt(hex.substring(2,4),16),parseInt(hex.substring(4,6),16)];
    }
    
    exportSettingsBtn.addEventListener('click', () => {
        const settings = collectSettingsFromUI();
        const json = JSON.stringify(settings, null, 2);
        settingsExportTextarea.value = json;
        // Automatisch kopiëren naar klembord
        settingsExportTextarea.select();
        document.execCommand('copy');
        exportSettingsBtn.textContent = 'Gekopieerd!';
        setTimeout(()=>{ exportSettingsBtn.textContent = 'Exporteer'; }, 1200);
    });
    
    // === Real-time sync voor alle modus checkboxes ===
    // Joystick checkbox event listener
    const joystickCheckbox = document.getElementById('enableJoystick');
    if (joystickCheckbox) {
        joystickCheckbox.addEventListener('change', () => {
            const enabled = joystickCheckbox.checked;
            sendSettingUpdate({ 'joystick_mode_enabled': enabled });
            const debugCheckbox = document.getElementById('enableDebug');
            if (debugCheckbox && debugCheckbox.checked) {
                console.log('Joystick modus:', enabled ? 'ingeschakeld' : 'uitgeschakeld');
            }
        });
    }
    
    // Alle andere modus checkboxes real-time maken
    const gpioCheckbox = document.getElementById('enableGPIO');
    if (gpioCheckbox) {
        gpioCheckbox.addEventListener('change', () => {
            const enabled = gpioCheckbox.checked;
            // Stuur GPIO modus instelling naar device
            const gpioSettings = {
                'gpio_mode_enabled': enabled,
                'gpio_duration': enabled ? parseInt(document.getElementById('gpioDuration').value) : 0
            };
            sendSettingUpdate(gpioSettings);
            if (debugCheckbox && debugCheckbox.checked) {
                debugLog('GPIO modus:', enabled ? 'ingeschakeld' : 'uitgeschakeld');
            }
        });
    }

    // Deadzone slider real-time maken
    const deadzoneSlider = document.getElementById('deadzone');
    if (deadzoneSlider) {
        deadzoneSlider.addEventListener('input', () => {
            const value = parseFloat(deadzoneSlider.value);
            // Update de value display
            const valueDisplay = document.getElementById('deadzoneValue');
            if (valueDisplay) {
                valueDisplay.textContent = value.toFixed(2);
            }
            sendSettingUpdate({ 'deadzone': value });
            debugLog('Deadzone aangepast naar:', value);
        });
    }

    // Joystick max waarden sliders real-time maken
    const joystickInhaleMaxSlider = document.getElementById('joystickInhaleMax');
    if (joystickInhaleMaxSlider) {
        joystickInhaleMaxSlider.addEventListener('input', () => {
            const value = parseFloat(joystickInhaleMaxSlider.value);
            sendSettingUpdate({ 'joystick_inhale_max': value });
            debugLog('Joystick inademen max aangepast naar:', value);
        });
    }

    const joystickExhaleMaxSlider = document.getElementById('joystickExhaleMax');
    if (joystickExhaleMaxSlider) {
        joystickExhaleMaxSlider.addEventListener('input', () => {
            const value = parseFloat(joystickExhaleMaxSlider.value);
            sendSettingUpdate({ 'joystick_exhale_max': value });
            debugLog('Joystick uitademen max aangepast naar:', value);
        });
    }
    
    const ledCheckbox = document.getElementById('enableLED');
    if (ledCheckbox) {
        ledCheckbox.addEventListener('change', () => {
            const enabled = ledCheckbox.checked;
            sendSettingUpdate({ 'led_enabled': enabled });
            debugLog('LED modus:', enabled ? 'ingeschakeld' : 'uitgeschakeld');
        });
    }
    
    const pepCheckbox = document.getElementById('enablePEP');
    if (pepCheckbox) {
        pepCheckbox.addEventListener('change', () => {
            const enabled = pepCheckbox.checked;
            sendSettingUpdate({ 'pep_mode_enabled': enabled });
            debugLog('PEP modus:', enabled ? 'ingeschakeld' : 'uitgeschakeld');
        });
    }
    
    const mp3Checkbox = document.getElementById('enableMP3');
    if (mp3Checkbox) {
        mp3Checkbox.addEventListener('change', () => {
            const enabled = mp3Checkbox.checked;
            sendSettingUpdate({ 'dfplayer_enabled': enabled });
            debugLog('MP3 modus:', enabled ? 'ingeschakeld' : 'uitgeschakeld');
        });
    }
    
    // === Debug Toggle Event Listener ===
    const debugCheckbox = document.getElementById('enableDebug');
    if (debugCheckbox) {
        debugCheckbox.addEventListener('change', () => {
            const enabled = debugCheckbox.checked;
            sendSettingUpdate({ 'debug_enabled': enabled });
            debugLog('Debug output:', enabled ? 'ingeschakeld' : 'uitgeschakeld');
        });
    }
    
    // === Real-time sync voor joystick richtingen ===
    const blowDirectionSelect = document.getElementById('blowDirection');
    if (blowDirectionSelect) {
        blowDirectionSelect.addEventListener('change', () => {
            const direction = blowDirectionSelect.value;
            sendSettingUpdate({ 'blow_direction': direction });
            debugLog('Blazen richting aangepast naar:', direction);
        });
    }
    
    const inhaleDirectionSelect = document.getElementById('inhaleDirection');
    if (inhaleDirectionSelect) {
        inhaleDirectionSelect.addEventListener('change', () => {
            const direction = inhaleDirectionSelect.value;
            sendSettingUpdate({ 'inhale_direction': direction });
            debugLog('Inademen richting aangepast naar:', direction);
        });
    }
    
    // === Spelmodi aanvinken op basis van settings.json ===
    function updateModeCheckboxesFromSettings(settings) {
        debugLog("updateModeCheckboxesFromSettings aangeroepen", settings);
        // Debug
        const debugBox = document.getElementById('enableDebug');
        if (debugBox && settings.debug_enabled !== undefined) {
            debugBox.checked = settings.debug_enabled;
        }
        // Joystick/Gamepad
        const joystickBox = document.getElementById('enableJoystick');
        debugLog('enableJoystick:', joystickBox);
        joystickBox.checked = settings.joystick_mode_enabled !== false; // Default true als niet ingesteld
        if (settings.joystick_inhale_max !== undefined) document.getElementById('joystickInhaleMax').value = settings.joystick_inhale_max;
        if (settings.joystick_exhale_max !== undefined) document.getElementById('joystickExhaleMax').value = settings.joystick_exhale_max;
        if (settings.control_mode !== undefined) {
            document.getElementById('controlMode').value = settings.control_mode;
            updateControlModeUI(); // Update de UI om de juiste controls te tonen
        }
        if (settings.deadzone !== undefined) document.getElementById('deadzone').value = settings.deadzone;
        if (settings.blow_direction !== undefined) document.getElementById('blowDirection').value = settings.blow_direction;
        if (settings.inhale_direction !== undefined) document.getElementById('inhaleDirection').value = settings.inhale_direction;
        if (settings.blow_button !== undefined) document.getElementById('expiratieButton').value = settings.blow_button;
        if (settings.inhale_button !== undefined) document.getElementById('inspiratieButton').value = settings.inhale_button;
        if (settings.blow_threshold !== undefined) document.getElementById('expiratieThreshold').value = settings.blow_threshold;
        if (settings.inhale_threshold !== undefined) document.getElementById('inspiratieThreshold').value = settings.inhale_threshold;
        
        // Update knoppen testbalken na het laden van settings
        if (window.lastBreathValue !== undefined) {
            updateButtonTestbars(window.lastBreathValue);
        }
        // 3,5mm Output
        const gpioBox = document.getElementById('enableGPIO');
        gpioBox.checked = settings.gpio_mode_enabled === true;
        if (settings.blow_gpio_threshold !== undefined) document.getElementById('gpioExhaleThreshold').value = settings.blow_gpio_threshold;
        if (settings.inhale_gpio_threshold !== undefined) document.getElementById('gpioInhaleThreshold').value = settings.inhale_gpio_threshold;
        if (settings.gpio_duration !== undefined) document.getElementById('gpioDuration').value = settings.gpio_duration;
        // LED Spel
        const ledBox = document.getElementById('enableLED');
        ledBox.checked = !!settings.led_enabled;
        if (settings.led_start_brightness !== undefined) document.getElementById('ledStartBrightness').value = Math.round(settings.led_start_brightness*100);
        if (settings.led_max_brightness !== undefined) document.getElementById('ledMaxBrightness').value = Math.round(settings.led_max_brightness*100);
        if (settings.led_color_mode !== undefined) document.getElementById('ledColorMode').value = settings.led_color_mode;
        if (settings.led_single_color !== undefined && document.getElementById('ledSingleColor')) {
            // Zet kleur als hex
            const rgb = settings.led_single_color;
            const hex = '#' + rgb.map(x => x.toString(16).padStart(2,'0')).join('');
            document.getElementById('ledSingleColor').value = hex;
        }
        // PEP Modus
        const pepBox = document.getElementById('enablePEP');
        pepBox.checked = !!settings.pep_mode_enabled;
        if (settings.pep_target_value !== undefined) document.getElementById('pepTarget').value = settings.pep_target_value;
        if (settings.pep_hold_time !== undefined && document.getElementById('pepSuccessTime')) {
            document.getElementById('pepSuccessTime').value = settings.pep_hold_time;
            document.getElementById('pepSuccessTimeValue').textContent = parseFloat(settings.pep_hold_time).toFixed(1);
        }
        if (settings.pep_start_brightness !== undefined && document.getElementById('pepStartBrightness')) document.getElementById('pepStartBrightness').value = Math.round(settings.pep_start_brightness*100);
        if (settings.pep_max_brightness !== undefined && document.getElementById('pepMaxBrightness')) document.getElementById('pepMaxBrightness').value = Math.round(settings.pep_max_brightness*100);
        if (settings.pep_blink_times !== undefined && document.getElementById('pepBlinkCount')) document.getElementById('pepBlinkCount').value = settings.pep_blink_times;
        if (settings.pep_blink_speed !== undefined && document.getElementById('pepBlinkSpeed')) document.getElementById('pepBlinkSpeed').value = settings.pep_blink_speed;
        if (settings.pep_repeat_count !== undefined && document.getElementById('pepRepeatCount')) document.getElementById('pepRepeatCount').value = settings.pep_repeat_count;
        if (settings.pep_reward_browser_mp3 !== undefined && document.getElementById('pepRewardBrowserMp3')) document.getElementById('pepRewardBrowserMp3').value = settings.pep_reward_browser_mp3;
        if (settings.pep_reward_gpio_duration !== undefined && document.getElementById('pepRewardGpioDuration')) {
            document.getElementById('pepRewardGpioDuration').value = settings.pep_reward_gpio_duration;
            document.getElementById('pepRewardGpioDurationValue').textContent = settings.pep_reward_gpio_duration;
        }
        // MP3 Speler
        const mp3Box = document.getElementById('enableMP3');
        mp3Box.checked = !!settings.dfplayer_enabled;
        if (settings.min_volume !== undefined && document.getElementById('mp3MinVolume')) document.getElementById('mp3MinVolume').value = settings.min_volume;
        if (settings.max_volume !== undefined && document.getElementById('mp3MaxVolume')) document.getElementById('mp3MaxVolume').value = settings.max_volume;
        if (settings.mp3_sensitivity !== undefined && document.getElementById('mp3Sensitivity')) document.getElementById('mp3Sensitivity').value = settings.mp3_sensitivity;
        if (settings.track_change_threshold !== undefined && document.getElementById('mp3InhaleNextThreshold')) document.getElementById('mp3InhaleNextThreshold').value = settings.track_change_threshold;
    }
    // --- Settings automatisch toepassen bij laden (indien settingsCache gevuld) ---
    if (window.settingsCache && Object.keys(window.settingsCache).length > 0) {
        updateModeCheckboxesFromSettings(window.settingsCache);
    }
    
    // Backup functie implementatie
    const copySettingsBtn = document.getElementById('copySettings');
    const backupNameInput = document.getElementById('backupName');
    const backupFileInput = document.getElementById('backupFile');
    
    // Exporteer instellingen naar PC bestand
    exportSettingsBtn.addEventListener('click', () => {
        try {
            const backupName = backupNameInput.value.trim() || 'groovtube_backup';
            const jsonData = JSON.stringify(settingsCache, null, 2);
            const blob = new Blob([jsonData], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${backupName}_${new Date().toISOString().split('T')[0]}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            setStatus(`Backup geëxporteerd: ${a.download}`, true);
            showToast(`✅ Backup geëxporteerd: ${a.download}`, 'success');
        } catch (e) {
            setStatus('Fout bij exporteren: ' + e.message, false);
            showToast(`❌ Fout bij exporteren: ${e.message}`, 'error');
        }
    });
    
    // Importeer instellingen van PC bestand
    backupFileInput.addEventListener('change', (event) => {
        const file = event.target.files[0];
        if (!file) return;
        
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const jsonData = e.target.result;
                
                // Controleer of het bestand niet leeg is
                if (!jsonData.trim()) {
                    throw new Error('Bestand is leeg');
                }
                
                const settings = JSON.parse(jsonData);
                
                // Controleer of het een geldig settings object is
                if (typeof settings !== 'object' || settings === null) {
                    throw new Error('Bestand bevat geen geldige instellingen');
                }
                
                // Controleer of er tenminste enkele instellingen zijn
                const settingKeys = Object.keys(settings);
                if (settingKeys.length === 0) {
                    throw new Error('Bestand bevat geen instellingen');
                }
                
                // Update de UI met de geïmporteerde instellingen
                settingsCache = { ...settingsCache, ...settings };
                updateModeCheckboxesFromSettings(settings);
                updateSlidersFromSettings(settings);
                
                            // Update de settings export area
            const settingsExportArea = document.getElementById('settingsExport');
            if (settingsExportArea) {
                settingsExportArea.value = JSON.stringify(settingsCache, null, 2);
            }
                
                // Stuur alle instellingen naar het device
                Object.keys(settings).forEach(key => {
                    sendCommand('SET:settings::' + JSON.stringify({ [key]: settings[key] }));
                });
                
                setStatus(`✅ Backup succesvol geïmporteerd: ${file.name} (${settingKeys.length} instellingen) - UI en device bijgewerkt`, true);
                showToast(`✅ Backup geïmporteerd: ${file.name} (${settingKeys.length} instellingen)`, 'success');
                backupFileInput.value = ''; // Reset file input
                
                // Debug: toon welke instellingen zijn geïmporteerd
                debugLog('Backup geïmporteerd:', settings);
                debugLog('Aantal geïmporteerde instellingen:', settingKeys.length);
            } catch (e) {
                setStatus(`❌ Fout bij importeren: ${e.message}`, false);
                showToast(`❌ Fout bij importeren: ${e.message}`, 'error');
                console.error('Import error:', e);
                backupFileInput.value = ''; // Reset file input bij fout
            }
        };
        
        // Foutafhandeling voor het lezen van het bestand
        reader.onerror = () => {
            setStatus('❌ Fout bij het lezen van het bestand', false);
            showToast('❌ Fout bij het lezen van het bestand', 'error');
            backupFileInput.value = ''; // Reset file input
        };
        
        reader.readAsText(file);
    });
    
    // Kopieer instellingen naar klembord
    copySettingsBtn.addEventListener('click', () => {
        try {
            const jsonData = JSON.stringify(settingsCache, null, 2);
            navigator.clipboard.writeText(jsonData).then(() => {
                setStatus('Instellingen gekopieerd naar klembord', true);
                showToast('✅ Instellingen gekopieerd naar klembord', 'success');
            }).catch(() => {
                setStatus('Fout bij kopiëren naar klembord', false);
                showToast('❌ Fout bij kopiëren naar klembord', 'error');
            });
        } catch (e) {
            setStatus('Fout bij kopiëren: ' + e.message, false);
            showToast(`❌ Fout bij kopiëren: ${e.message}`, 'error');
        }
    });
    
    // Importeer instellingen van klembord
    importSettingsBtn.addEventListener('click', () => {
        try {
            const jsonData = settingsExportArea.value.trim();
            if (!jsonData) {
                setStatus('❌ Voer eerst JSON data in het tekstvak', false);
                showToast('❌ Voer eerst JSON data in het tekstvak', 'error');
                return;
            }
            
            const settings = JSON.parse(jsonData);
            
            // Controleer of het een geldig settings object is
            if (typeof settings !== 'object' || settings === null) {
                throw new Error('Tekst bevat geen geldige instellingen');
            }
            
            // Controleer of er tenminste enkele instellingen zijn
            const settingKeys = Object.keys(settings);
            if (settingKeys.length === 0) {
                throw new Error('Tekst bevat geen instellingen');
            }
            
            // Update de UI met de geïmporteerde instellingen
            settingsCache = { ...settingsCache, ...settings };
            updateModeCheckboxesFromSettings(settings);
            updateSlidersFromSettings(settings);
            
            // Update de settings export area
            const settingsExportArea = document.getElementById('settingsExport');
            if (settingsExportArea) {
                settingsExportArea.value = JSON.stringify(settingsCache, null, 2);
            }
            
            // Stuur alle instellingen naar het device
            Object.keys(settings).forEach(key => {
                sendCommand('SET:settings::' + JSON.stringify({ [key]: settings[key] }));
            });
            
            setStatus(`✅ Klembord instellingen succesvol geïmporteerd (${settingKeys.length} instellingen) - UI en device bijgewerkt`, true);
            showToast(`✅ Klembord instellingen geïmporteerd (${settingKeys.length} instellingen)`, 'success');
            
            // Debug: toon welke instellingen zijn geïmporteerd
            debugLog('Klembord instellingen geïmporteerd:', settings);
            debugLog('Aantal geïmporteerde instellingen:', settingKeys.length);
        } catch (e) {
            setStatus(`❌ Fout bij importeren van klembord: ${e.message}`, false);
            showToast(`❌ Fout bij importeren van klembord: ${e.message}`, 'error');
            console.error('Klembord import error:', e);
        }
    });
    
    // Laad instellingen bij startup (via device verbinding)
    // Instellingen worden geladen wanneer de gebruiker verbinding maakt met het device
    console.log('Instellingen worden geladen via device verbinding');
    
    // Functie om settings export area bij te werken
    function updateSettingsExportArea() {
        const settingsExportArea = document.getElementById('settingsExport');
        if (settingsExportArea && settingsCache) {
            settingsExportArea.value = JSON.stringify(settingsCache, null, 2);
        }
    }
    
    // Initialiseer de 'unsaved changes' indicator
    updateUnsavedChangesIndicator();
    
    // Sluit de hoofdfunctie
    });
