// Auth check
const token = localStorage.getItem('token');
const currentUser = localStorage.getItem('username');
if (!token || !currentUser) {
    window.location.href = '/login.html';
}

let ws;
let gameState = 'IDLE';
let tiles = [];

// UI Elements
const balanceDisplay = document.getElementById('balance-display');
const betAmountInput = document.getElementById('bet-amount');
const mineCountSelect = document.getElementById('mine-count');
const gemsRemainingInput = document.getElementById('gems-remaining');
const btnPlay = document.getElementById('btn-play');
const btnCashout = document.getElementById('btn-cashout');
const btnRandom = document.getElementById('btn-random');
const btnHalf = document.getElementById('btn-half');
const btnDouble = document.getElementById('btn-double');
const gameGrid = document.getElementById('game-grid');
const gameMessage = document.getElementById('game-message');
const profitContainer = document.getElementById('profit-container');
const currentMultiplierSpan = document.getElementById('current-multiplier');
const profitAmountInput = document.getElementById('profit-amount');

function connectWebSocket() {
    ws = new WebSocket(`ws://${location.host}/ws/game`);

    ws.onopen = () => {
        // Authenticate the WebSocket connection
        ws.send(JSON.stringify({ action: 'AUTH', token }));
    };

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);

        if (data.error) {
            if (data.error === 'Invalid session') {
                localStorage.clear();
                window.location.href = '/login.html';
                return;
            }
            showMessage(data.error, 'error');
            return;
        }

        switch (data.type) {
            case 'AUTH_OK':
                console.log('Authenticated as', data.username);
                break;

            case 'GAME_STARTED':
                gameState = 'PLAYING';
                updateBalanceDisplay(data.balance);
                showMessage('Game Started! Pick tiles carefully.', 'success');
                btnPlay.classList.add('hidden');
                btnCashout.classList.remove('hidden');
                btnCashout.textContent = 'Cashout';
                btnRandom.classList.remove('hidden');
                profitContainer.classList.remove('hidden');
                betAmountInput.disabled = true;
                mineCountSelect.disabled = true;
                tiles.forEach(t => t.className = 'tile');
                break;

            case 'TILE_REVEALED':
                revealTile(data.index, data.tile);
                currentMultiplierSpan.textContent = data.currentMultiplier.toFixed(2);
                profitAmountInput.value = data.currentPayout.toFixed(2);
                btnCashout.textContent = `Cashout $${data.currentPayout.toFixed(2)}`;
                break;

            case 'GAME_OVER':
                handleGameOver(data);
                break;
        }
    };

    ws.onclose = () => {
        setTimeout(connectWebSocket, 2000);
    };

    ws.onerror = () => { };
}

function initGrid() {
    gameGrid.innerHTML = '';
    tiles = [];
    for (let i = 0; i < 25; i++) {
        const tile = document.createElement('div');
        tile.className = 'tile';
        tile.dataset.index = i;
        tile.addEventListener('click', () => handleTileClick(i));
        gameGrid.appendChild(tile);
        tiles.push(tile);
    }
}

function updateBalanceDisplay(amount) {
    balanceDisplay.textContent = '$' + parseFloat(amount).toFixed(2);
}

async function fetchBalance() {
    try {
        const res = await fetch('/api/me', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        if (data.balance !== undefined) updateBalanceDisplay(data.balance);
        if (data.error === 'Not authenticated') {
            localStorage.clear();
            window.location.href = '/login.html';
        }
    } catch (err) { }
}

function handleTileClick(index) {
    if (gameState !== 'PLAYING') return;
    if (ws.readyState !== WebSocket.OPEN) return;
    const tile = tiles[index];
    if (tile.classList.contains('revealed')) return;
    ws.send(JSON.stringify({ action: 'REVEAL', index }));
}

function revealTile(index, type, dimmed) {
    const tile = tiles[index];
    tile.classList.add('revealed', type);
    if (dimmed) tile.classList.add('dimmed');
    if (!tile.querySelector('.tile-icon')) {
        const img = document.createElement('img');
        img.className = 'tile-icon';
        img.src = type === 'gem' ? '/assets/gem.svg' : '/assets/bomb.svg';
        img.alt = type;
        tile.appendChild(img);
    }
    if (type === 'gem' && !dimmed) {
        let current = parseInt(gemsRemainingInput.value);
        gemsRemainingInput.value = Math.max(0, current - 1);
    }
}

function handleGameOver(data) {
    gameState = 'IDLE';
    data.board.forEach((type, index) => {
        const tile = tiles[index];
        if (!tile.classList.contains('revealed')) {
            revealTile(index, type, true);
        }
    });
    if (data.result === 'loss') {
        tiles.forEach(tile => {
            if (tile.classList.contains('mine') && !tile.classList.contains('dimmed'))
                tile.classList.add('mine-hit');
        });
        showMessage('💣 You hit a mine! Bet lost.', 'error');
    } else {
        const reason = data.result === 'cashout' ? 'Cashed Out!' : '🎉 Board Cleared!';
        showMessage(`${reason} Won $${data.payout.toFixed(2)} (${data.multiplier}x)`, 'success');
        updateBalanceDisplay(data.newBalance);
    }
    resetToIdle();
}

function resetToIdle() {
    btnPlay.classList.remove('hidden');
    btnCashout.classList.add('hidden');
    btnRandom.classList.add('hidden');
    betAmountInput.disabled = false;
    mineCountSelect.disabled = false;
    setTimeout(() => {
        if (gameState === 'IDLE') {
            initGrid();
            currentMultiplierSpan.textContent = "1.00";
            profitAmountInput.value = "0.00";
            updateGemsRemaining();
        }
    }, 2500);
}

function showMessage(msg, type) {
    gameMessage.textContent = msg;
    gameMessage.className = `message ${type}`;
    gameMessage.classList.remove('hidden');
    setTimeout(() => gameMessage.classList.add('hidden'), 3500);
}

function updateGemsRemaining() {
    gemsRemainingInput.value = 25 - parseInt(mineCountSelect.value);
}

// Event Listeners
btnPlay.addEventListener('click', () => {
    if (gameState === 'PLAYING') return;
    if (ws.readyState !== WebSocket.OPEN) { showMessage('Connecting...', 'error'); return; }
    initGrid(); updateGemsRemaining();
    currentMultiplierSpan.textContent = "1.00";
    profitAmountInput.value = "0.00";
    ws.send(JSON.stringify({ action: 'BET', betAmount: betAmountInput.value, mines: mineCountSelect.value }));
});

btnCashout.addEventListener('click', () => {
    if (gameState !== 'PLAYING') return;
    ws.send(JSON.stringify({ action: 'CASHOUT' }));
});

btnRandom.addEventListener('click', () => {
    if (gameState !== 'PLAYING') return;
    const unrevealed = tiles.filter(t => !t.classList.contains('revealed'));
    if (unrevealed.length > 0) {
        const r = unrevealed[Math.floor(Math.random() * unrevealed.length)];
        handleTileClick(parseInt(r.dataset.index));
    }
});

mineCountSelect.addEventListener('change', updateGemsRemaining);
btnHalf.addEventListener('click', () => {
    let v = parseFloat(betAmountInput.value);
    if (!isNaN(v)) betAmountInput.value = Math.max(0.5, v / 2).toFixed(2);
});
btnDouble.addEventListener('click', () => {
    let v = parseFloat(betAmountInput.value);
    if (!isNaN(v)) betAmountInput.value = (v * 2).toFixed(2);
});

// Logout button
const logoutBtn = document.getElementById('btn-logout');
if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
        localStorage.clear();
        window.location.href = '/login.html';
    });
}

// Show username
const userLabel = document.getElementById('user-label');
if (userLabel) userLabel.textContent = currentUser;

// Init
initGrid(); fetchBalance(); updateGemsRemaining(); connectWebSocket();
