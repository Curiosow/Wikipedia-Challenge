const socket = io();
let currentUser = null;
let currentRoom = null;
let timerInterval = null;
let gameSettings = null;

window.addEventListener('load', () => {
    fetch('/api/me')
        .then(res => res.json())
        .then(user => {
            if (user) {
                currentUser = user;
                showScreen('menu-screen');
                document.getElementById('user-welcome').innerText = `Salut, ${user.username} !`;
                socket.emit('recover_session', currentUser);
            } else { showScreen('login-screen'); }
        }).catch(() => showScreen('login-screen'));
});

function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
    document.getElementById(id).classList.remove('hidden');
}

// --- NOTIFICATIONS ---
function showNotification(message, type = 'info') {
    const container = document.getElementById('notification-area');
    const notif = document.createElement('div');
    notif.className = `notification notif-${type}`;
    notif.innerHTML = message;
    container.appendChild(notif);
    setTimeout(() => {
        notif.style.opacity = '0';
        notif.style.transform = 'translateX(100%)';
        setTimeout(() => notif.remove(), 300);
    }, 4000);
}

// --- ANIMATIONS ---
function startCountdown() {
    const overlay = document.getElementById('countdown-overlay');
    const numberEl = document.getElementById('countdown-number');
    overlay.classList.remove('hidden');
    let count = 3;
    numberEl.innerText = count;
    const interval = setInterval(() => {
        count--;
        if (count > 0) {
            numberEl.innerText = count;
            numberEl.style.animation = 'none';
            numberEl.offsetHeight; 
            numberEl.style.animation = null; 
        } else {
            numberEl.innerText = "GO !";
            clearInterval(interval);
            setTimeout(() => { overlay.classList.add('hidden'); }, 500);
        }
    }, 1000);
}

function closeVictoryScreen() {
    document.getElementById('victory-screen').classList.add('hidden');
}

function closeFinalScreen() {
    document.getElementById('final-screen').classList.add('hidden');
}

// --- ACTIONS ---
function createGame() { socket.emit('join_lobby', { user: currentUser, roomCode: null }); }
function joinGame() {
    const code = document.getElementById('join-code').value.toUpperCase().trim();
    if(code) socket.emit('join_lobby', { user: currentUser, roomCode: code });
    else showNotification("Veuillez entrer un code", "error");
}
function startGame() { socket.emit('start_game', currentRoom.code); }
function updateSettings() {
    const mode = document.getElementById('setting-mode').value;
    const timeLimit = parseInt(document.getElementById('setting-time').value) || 0;
    const rounds = parseInt(document.getElementById('setting-rounds').value) || 3;
    socket.emit('update_settings', { roomCode: currentRoom.code, settings: { mode, timeLimit, rounds } });
}
function forfeitGame() {
    if(confirm("Abandonner ?")) {
        socket.emit('forfeit', currentRoom.code);
        document.getElementById('btn-forfeit').classList.add('hidden');
        document.querySelector('.placeholder-text h2').innerText = "Abandon...";
        document.querySelector('.placeholder-text').style.display = 'block';
        document.getElementById('wiki-frame').style.display = 'none';
    }
}

// --- SOCKET EVENTS ---
socket.on('error', (msg) => showNotification(msg, 'error'));
socket.on('notification', ({ type, message }) => showNotification(message, type));

socket.on('room_joined', (room) => {
    currentRoom = room;
    gameSettings = room.settings;
    showScreen('game-screen');
    updateLobbyUI();
    syncSettingsUI(room.settings);
});

socket.on('settings_updated', (settings) => {
    currentRoom.settings = settings;
    gameSettings = settings;
    syncSettingsUI(settings);
});

socket.on('room_update', (room) => {
    currentRoom = room;
    updateLobbyUI();
});

socket.on('round_prepare', ({ startPage, targetPage, round, totalRounds }) => {
    document.getElementById('game-header').classList.remove('hidden');
    document.getElementById('start-target').innerText = startPage;
    document.getElementById('end-target').innerText = targetPage;
    document.getElementById('round-info').innerText = `Round ${round} / ${totalRounds}`;
    document.getElementById('host-settings').classList.add('hidden');
    document.getElementById('guest-settings').classList.add('hidden');
    
    // Fermer les modales si ouvertes
    closeVictoryScreen();
    closeFinalScreen();

    const iframe = document.getElementById('wiki-frame');
    iframe.src = `/wiki-proxy?room=${currentRoom.code}&page=${encodeURIComponent(startPage)}`;
    iframe.style.display = 'block';
    document.querySelector('.placeholder-text').style.display = 'none';
    
    startCountdown();
});

socket.on('round_start', ({ startTime, settings }) => {
    gameSettings = settings;
    document.getElementById('btn-forfeit').classList.remove('hidden');
    startClientTimer(startTime, settings.timeLimit);
});

socket.on('round_start_immediate', ({ startPage, targetPage, round, totalRounds, recoverPage, startTime, settings }) => {
    gameSettings = settings;
    document.getElementById('game-header').classList.remove('hidden');
    document.getElementById('start-target').innerText = startPage;
    document.getElementById('end-target').innerText = targetPage;
    document.getElementById('round-info').innerText = `Round ${round} / ${totalRounds}`;
    document.getElementById('btn-forfeit').classList.remove('hidden');
    
    document.querySelector('.placeholder-text').style.display = 'none';
    const iframe = document.getElementById('wiki-frame');
    const pageToLoad = recoverPage || startPage;
    iframe.src = `/wiki-proxy?room=${currentRoom.code}&page=${encodeURIComponent(pageToLoad)}`;
    iframe.style.display = 'block';
    
    startClientTimer(startTime, settings.timeLimit);
});

socket.on('progress_update', ({ playerId, clicks, currentPage }) => {
    const elClicks = document.getElementById(`p-clicks-${playerId}`);
    const elPage = document.getElementById(`p-page-${playerId}`);
    if (elClicks) elClicks.innerText = `${clicks} clics`;
    if (elPage) elPage.innerText = currentPage;
});

socket.on('player_finished', ({ player }) => {
    const row = Array.from(document.querySelectorAll('.player-card')).find(el => el.innerHTML.includes(player));
    if(row) row.style.borderLeft = "4px solid gold"; 
});

socket.on('player_forfeited', ({ playerId }) => {
    const elPage = document.getElementById(`p-page-${playerId}`);
    if (elPage) { elPage.innerText = "🏳️ A abandonné"; elPage.style.color = "red"; }
});

socket.on('round_end', ({ winnerName, room }) => {
    stopClientTimer();
    currentRoom = room;
    updateLobbyUI();
    resetGameView(room);

    // MODALE DE FIN DE ROUND
    const victoryScreen = document.getElementById('victory-screen');
    const victoryContent = document.querySelector('.victory-content');
    const victoryTitle = document.getElementById('victory-title');
    const victoryMsg = document.getElementById('victory-message');
    const victoryAvatar = document.getElementById('victory-avatar');

    victoryScreen.classList.remove('hidden');
    
    if (winnerName) {
        victoryContent.classList.remove('draw'); victoryContent.classList.add('win');
        victoryTitle.innerText = "VICTOIRE !"; victoryTitle.style.color = "#f1c40f";
        victoryAvatar.innerText = "🏆"; victoryMsg.innerText = `Bravo à ${winnerName} !`;
    } else {
        victoryContent.classList.remove('win'); victoryContent.classList.add('draw');
        victoryTitle.innerText = "AUCUN GAGNANT"; victoryTitle.style.color = "#bdc3c7";
        victoryAvatar.innerText = "🏳️"; victoryMsg.innerText = "Abandon général ou temps écoulé.";
    }
});

// NOUVEAU : GESTION FIN DE PARTIE COMPLETE
socket.on('game_over', ({ leaderboard, room }) => {
    stopClientTimer();
    currentRoom = room;
    updateLobbyUI();
    resetGameView(room);
    
    const finalScreen = document.getElementById('final-screen');
    const podiumDiv = document.getElementById('podium-container');
    podiumDiv.innerHTML = ''; // Clear

    leaderboard.forEach((p, index) => {
        const place = index + 1;
        let medal = '';
        if (place === 1) medal = '🥇';
        if (place === 2) medal = '🥈';
        if (place === 3) medal = '🥉';

        const row = document.createElement('div');
        row.className = 'leaderboard-row';
        row.innerHTML = `
            <div class="rank">${place}</div>
            <div class="name">${medal} ${p.username}</div>
            <div class="score">${p.score} pts</div>
        `;
        podiumDiv.appendChild(row);
    });

    finalScreen.classList.remove('hidden');
});

function resetGameView(room) {
    document.getElementById('game-header').classList.add('hidden');
    document.getElementById('wiki-frame').style.display = 'none';
    document.getElementById('timer-display').classList.add('hidden');
    document.getElementById('btn-forfeit').classList.add('hidden');
    document.querySelector('.placeholder-text').style.display = 'block';
    document.querySelector('.placeholder-text h2').innerText = "En attente...";
    syncSettingsUI(room.settings);
}

function updateLobbyUI() {
    document.getElementById('display-code').innerText = currentRoom.code;
    const list = document.getElementById('players-list');
    list.innerHTML = '';
    currentRoom.players.forEach(p => {
        const isMe = p.id === currentUser.id;
        const div = document.createElement('div');
        div.className = `player-card ${isMe ? 'my-card' : ''}`;
        if(p.finished) div.classList.add('finished');
        const scoreBadge = p.score > 0 ? `<span class="score-badge">🏆 ${p.score}</span>` : '';
        div.innerHTML = `
            <div class="p-header"><strong>${p.username}</strong> ${scoreBadge}</div>
            <div class="p-stats">
                <small>🖱️ <span id="p-clicks-${p.id}">${p.clicks}</span></small>
                <small>📄 <span id="p-page-${p.id}" class="page-name">${p.currentPage || '-'}</span></small>
            </div>
        `;
        list.appendChild(div);
    });
    const isHost = currentRoom.host === currentUser.id;
    const isLobby = currentRoom.state === 'LOBBY';
    const btnStart = document.getElementById('btn-start');
    
    if (isHost && isLobby) {
        btnStart.classList.remove('hidden');
        document.getElementById('host-settings').classList.remove('hidden');
        document.getElementById('guest-settings').classList.add('hidden');
        btnStart.innerText = (currentRoom.currentRound === 0) ? "LANCER LA PARTIE" : "ROUND SUIVANT";
    } else if (isLobby) {
        btnStart.classList.add('hidden');
        document.getElementById('host-settings').classList.add('hidden');
        document.getElementById('guest-settings').classList.remove('hidden');
    } else {
        btnStart.classList.add('hidden');
    }
}

function syncSettingsUI(settings) {
    if (!settings) return;
    document.getElementById('info-mode').innerText = settings.mode === 'SPEED' ? 'Vitesse' : 'Clics min.';
    document.getElementById('info-time').innerText = settings.timeLimit > 0 ? `${settings.timeLimit} sec` : 'Infini';
    document.getElementById('info-rounds').innerText = settings.rounds;
}

function startClientTimer(startTime, limit) {
    const display = document.getElementById('timer-display');
    display.classList.remove('hidden');
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
        const now = Date.now();
        const elapsedSec = Math.floor((now - startTime) / 1000);
        if (limit > 0) {
            const remaining = limit - elapsedSec;
            if (remaining <= 0) {
                display.innerText = "00:00"; display.style.color = "red";
            } else {
                display.innerText = formatTime(remaining); display.style.color = remaining < 10 ? "red" : "white";
            }
        } else {
            display.innerText = formatTime(elapsedSec); display.style.color = "white";
        }
    }, 1000);
}
function stopClientTimer() { if (timerInterval) clearInterval(timerInterval); }
function formatTime(seconds) {
    const m = Math.floor(seconds / 60).toString().padStart(2, '0');
    const s = (seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
}

window.addEventListener('message', (event) => {
    if (event.data.type === 'page_click') {
        socket.emit('player_navigated', { roomCode: currentRoom.code, page: event.data.page });
        const iframe = document.getElementById('wiki-frame');
        iframe.src = `/wiki-proxy?room=${currentRoom.code}&page=${encodeURIComponent(event.data.page)}`;
    }
});