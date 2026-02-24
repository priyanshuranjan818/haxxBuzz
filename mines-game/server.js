const fastify = require('fastify')({ logger: true });
const path = require('path');
const { db, hashPassword } = require('./db');

// Register plugins
fastify.register(require('@fastify/static'), {
    root: path.join(__dirname, 'public'),
});
fastify.register(require('@fastify/websocket'));

// Simple in-memory session store (MVP)
const sessions = new Map(); // token -> username

function generateToken() {
    return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

// Multiplier calculation
function calculateMultiplier(mines, safeClicks) {
    if (safeClicks === 0) return 1.0;
    let houseEdge = 0.99;
    let remainingSafe = 25 - mines;
    let multiplier = 1.0;
    for (let i = 0; i < safeClicks; i++) {
        multiplier *= (25 - i) / (remainingSafe - i);
    }
    return Number((multiplier * houseEdge).toFixed(2));
}

const activeGames = new Map();

// ==================== AUTH API ====================

// Signup
fastify.post('/api/signup', (request, reply) => {
    const { username, password } = request.body;
    if (!username || !password) return reply.code(400).send({ error: 'Username and password required' });
    if (username.length < 3) return reply.code(400).send({ error: 'Username must be at least 3 characters' });
    if (password.length < 4) return reply.code(400).send({ error: 'Password must be at least 4 characters' });

    const hashed = hashPassword(password);
    db.run(`INSERT INTO users (username, password, balance) VALUES (?, ?, 0.00)`, [username, hashed], function (err) {
        if (err) {
            if (err.message.includes('UNIQUE')) {
                return reply.code(409).send({ error: 'Username already taken' });
            }
            return reply.code(500).send({ error: 'Database error' });
        }
        reply.send({ success: true, message: 'Account created! Please login.' });
    });
});

// Login
fastify.post('/api/login', (request, reply) => {
    const { username, password } = request.body;
    if (!username || !password) return reply.code(400).send({ error: 'Username and password required' });

    const hashed = hashPassword(password);
    db.get(`SELECT id, username, balance FROM users WHERE username = ? AND password = ?`, [username, hashed], (err, row) => {
        if (err) return reply.code(500).send({ error: 'Database error' });
        if (!row) return reply.code(401).send({ error: 'Invalid username or password' });

        const token = generateToken();
        sessions.set(token, row.username);
        reply.send({ success: true, token, username: row.username, balance: row.balance });
    });
});

// Get balance (requires auth token)
fastify.get('/api/me', (request, reply) => {
    const token = request.headers.authorization?.replace('Bearer ', '');
    const username = sessions.get(token);
    if (!username) return reply.code(401).send({ error: 'Not authenticated' });

    db.get(`SELECT username, balance FROM users WHERE username = ?`, [username], (err, row) => {
        if (err || !row) return reply.code(500).send({ error: 'Error' });
        reply.send({ username: row.username, balance: row.balance });
    });
});

// ==================== ADMIN API ====================

fastify.post('/api/admin/login', (request, reply) => {
    const { username, password } = request.body;
    if (username === 'admin' && password === 'admin123') {
        reply.send({ success: true, token: 'admin-token-123' });
    } else {
        reply.code(401).send({ success: false, error: 'Invalid username or password' });
    }
});

fastify.get('/api/admin/users', (request, reply) => {
    const { authorization } = request.headers;
    if (authorization !== 'Bearer admin-token-123') return reply.code(401).send({ error: 'Unauthorized' });
    db.all(`SELECT id, username, balance, created_at FROM users ORDER BY created_at DESC`, [], (err, rows) => {
        if (err) return reply.code(500).send({ error: 'Database error' });
        reply.send(rows);
    });
});

fastify.post('/api/admin/add-funds', (request, reply) => {
    const { authorization } = request.headers;
    if (authorization !== 'Bearer admin-token-123') return reply.code(401).send({ error: 'Unauthorized' });
    const { username, amount } = request.body;
    if (!username || !amount || amount <= 0) return reply.code(400).send({ error: 'Invalid input' });
    db.run(`UPDATE users SET balance = balance + ? WHERE username = ?`, [amount, username], function (err) {
        if (err) return reply.code(500).send({ error: 'Database error' });
        if (this.changes === 0) return reply.code(404).send({ error: 'User not found' });
        db.get(`SELECT balance FROM users WHERE username = ?`, [username], (err, row) => {
            reply.send({ success: true, newBalance: row.balance });
        });
    });
});

// ==================== ADMIN: DELETE USER ====================

fastify.post('/api/admin/delete-user', (request, reply) => {
    const { authorization } = request.headers;
    if (authorization !== 'Bearer admin-token-123') return reply.code(401).send({ error: 'Unauthorized' });
    const { username } = request.body;
    if (!username) return reply.code(400).send({ error: 'Username required' });
    db.run(`DELETE FROM users WHERE username = ?`, [username], function (err) {
        if (err) return reply.code(500).send({ error: 'Database error' });
        if (this.changes === 0) return reply.code(404).send({ error: 'User not found' });
        reply.send({ success: true, message: `User ${username} deleted` });
    });
});

// ==================== WEBSOCKET GAME ====================

fastify.register(async function (fastify) {
    fastify.get('/ws/game', { websocket: true }, (socket, req) => {
        let username = null;

        socket.on('message', (message) => {
            try {
                const data = JSON.parse(message.toString());

                // First message must be AUTH
                if (data.action === 'AUTH') {
                    const u = sessions.get(data.token);
                    if (!u) return socket.send(JSON.stringify({ error: 'Invalid session' }));
                    username = u;
                    socket.send(JSON.stringify({ type: 'AUTH_OK', username }));
                    return;
                }

                if (!username) return socket.send(JSON.stringify({ error: 'Not authenticated' }));

                if (data.action === 'BET') {
                    const betAmount = parseFloat(data.betAmount);
                    const minesCount = parseInt(data.mines);
                    if (isNaN(betAmount) || betAmount <= 0) return socket.send(JSON.stringify({ error: 'Invalid bet amount' }));
                    if (minesCount < 1 || minesCount > 24) return socket.send(JSON.stringify({ error: 'Invalid mine count' }));
                    if (activeGames.has(username)) return socket.send(JSON.stringify({ error: 'Game already active' }));

                    db.get(`SELECT balance FROM users WHERE username = ?`, [username], (err, row) => {
                        if (err || !row) return socket.send(JSON.stringify({ error: 'User not found' }));
                        if (row.balance < betAmount) return socket.send(JSON.stringify({ error: 'Insufficient balance' }));

                        const newBalance = row.balance - betAmount;
                        db.run(`UPDATE users SET balance = ? WHERE username = ?`, [newBalance, username], (err) => {
                            if (err) return socket.send(JSON.stringify({ error: 'Error deducting balance' }));

                            let board = Array(25).fill('gem');
                            let minesPlaced = 0;
                            while (minesPlaced < minesCount) {
                                let idx = Math.floor(Math.random() * 25);
                                if (board[idx] !== 'mine') { board[idx] = 'mine'; minesPlaced++; }
                            }

                            activeGames.set(username, {
                                betAmount, minesCount, board,
                                revealedIndices: [], safeClicks: 0
                            });

                            socket.send(JSON.stringify({
                                type: 'GAME_STARTED', balance: newBalance,
                                betAmount, mines: minesCount
                            }));
                        });
                    });
                }

                else if (data.action === 'REVEAL') {
                    if (!activeGames.has(username)) return socket.send(JSON.stringify({ error: 'No active game' }));
                    const game = activeGames.get(username);
                    const index = parseInt(data.index);
                    if (index < 0 || index > 24 || game.revealedIndices.includes(index)) {
                        return socket.send(JSON.stringify({ error: 'Invalid tile' }));
                    }

                    game.revealedIndices.push(index);
                    const tileType = game.board[index];

                    if (tileType === 'mine') {
                        activeGames.delete(username);
                        socket.send(JSON.stringify({ type: 'GAME_OVER', result: 'loss', board: game.board }));
                    } else {
                        game.safeClicks++;
                        const currentMultiplier = calculateMultiplier(game.minesCount, game.safeClicks);
                        const currentPayout = Number((game.betAmount * currentMultiplier).toFixed(2));
                        const totalSafeTiles = 25 - game.minesCount;

                        if (game.safeClicks === totalSafeTiles) {
                            db.run(`UPDATE users SET balance = balance + ? WHERE username = ?`, [currentPayout, username], () => {
                                activeGames.delete(username);
                                db.get(`SELECT balance FROM users WHERE username = ?`, [username], (err, row) => {
                                    socket.send(JSON.stringify({
                                        type: 'GAME_OVER', result: 'win',
                                        payout: currentPayout, multiplier: currentMultiplier,
                                        newBalance: row.balance, board: game.board
                                    }));
                                });
                            });
                        } else {
                            socket.send(JSON.stringify({
                                type: 'TILE_REVEALED', index, tile: 'gem',
                                currentMultiplier, currentPayout
                            }));
                        }
                    }
                }

                else if (data.action === 'CASHOUT') {
                    if (!activeGames.has(username)) return socket.send(JSON.stringify({ error: 'No active game' }));
                    const game = activeGames.get(username);
                    if (game.safeClicks === 0) return socket.send(JSON.stringify({ error: 'Must reveal at least one tile' }));

                    const currentMultiplier = calculateMultiplier(game.minesCount, game.safeClicks);
                    const currentPayout = Number((game.betAmount * currentMultiplier).toFixed(2));

                    db.run(`UPDATE users SET balance = balance + ? WHERE username = ?`, [currentPayout, username], () => {
                        const finalBoard = game.board;
                        activeGames.delete(username);
                        db.get(`SELECT balance FROM users WHERE username = ?`, [username], (err, row) => {
                            socket.send(JSON.stringify({
                                type: 'GAME_OVER', result: 'cashout',
                                payout: currentPayout, multiplier: currentMultiplier,
                                newBalance: row.balance, board: finalBoard
                            }));
                        });
                    });
                }

            } catch (err) {
                console.error("WS parsing error:", err);
            }
        });

        socket.on('close', () => {
            if (username && activeGames.has(username)) {
                console.log(`Clearing abandoned game for ${username}`);
                activeGames.delete(username);
            }
        });
    });
});

const start = async () => {
    try { await fastify.listen({ port: 3000 }); }
    catch (err) { fastify.log.error(err); process.exit(1); }
};
start();
