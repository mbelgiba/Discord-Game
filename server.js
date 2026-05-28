const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

// Инициализация БД
const db = new sqlite3.Database('./database.db', (err) => {
    if (err) console.error('Ошибка БД:', err.message);
    console.log('Подключено к SQLite.');
});

// Создание таблиц
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT,
        tag TEXT,
        password TEXT,
        bio TEXT DEFAULT '',
        wins INTEGER DEFAULT 0,
        losses INTEGER DEFAULT 0,
        draws INTEGER DEFAULT 0,
        UNIQUE(username, tag)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS friends (
        user_id INTEGER,
        friend_id INTEGER,
        PRIMARY KEY (user_id, friend_id)
    )`);

    // Таблица приватных сообщений
    db.run(`CREATE TABLE IF NOT EXISTS private_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_id INTEGER,
        receiver_id INTEGER,
        content TEXT,
        msg_type TEXT DEFAULT 'text',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Добавляем колонки статистики если их нет (миграция)
    db.run(`ALTER TABLE users ADD COLUMN wins INTEGER DEFAULT 0`, () => {});
    db.run(`ALTER TABLE users ADD COLUMN losses INTEGER DEFAULT 0`, () => {});
    db.run(`ALTER TABLE users ADD COLUMN draws INTEGER DEFAULT 0`, () => {});
});

// --- API МАРШРУТЫ ---

// Регистрация
app.post('/api/auth/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Заполните все поля' });

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const tag = Math.floor(1000 + Math.random() * 9000).toString();
        
        db.run(`INSERT INTO users (username, tag, password) VALUES (?, ?, ?)`, [username, tag, hashedPassword], function(err) {
            if (err) return res.status(400).json({ error: 'Ошибка регистрации. Возможно, имя занято.' });
            res.json({ id: this.lastID, username, tag, bio: '', wins: 0, losses: 0, draws: 0 });
        });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Авторизация
app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    
    db.get(`SELECT * FROM users WHERE username = ?`, [username], async (err, user) => {
        if (err) return res.status(500).json({ error: 'Ошибка БД' });
        if (!user) return res.status(400).json({ error: 'Неверные данные' });

        const match = await bcrypt.compare(password, user.password);
        if (match) {
            res.json({ id: user.id, username: user.username, tag: user.tag, bio: user.bio, wins: user.wins || 0, losses: user.losses || 0, draws: user.draws || 0 });
        } else {
            res.status(400).json({ error: 'Неверные данные' });
        }
    });
});

// Получить профиль
app.get('/api/profile/:id', (req, res) => {
    db.get(`SELECT username, tag, bio, wins, losses, draws FROM users WHERE id = ?`, [req.params.id], (err, user) => {
        if (err || !user) return res.status(404).json({ error: 'Пользователь не найден' });
        res.json({ ...user, wins: user.wins || 0, losses: user.losses || 0, draws: user.draws || 0 });
    });
});

// Обновить профиль
app.post('/api/profile/update', (req, res) => {
    const { id, bio } = req.body;
    db.run(`UPDATE users SET bio = ? WHERE id = ?`, [bio, id], function(err) {
        if (err) return res.status(500).json({ error: 'Ошибка обновления' });
        res.json({ success: true, bio });
    });
});

// Добавить в друзья
app.post('/api/friends/add', (req, res) => {
    const { myId, friendString } = req.body;
    const [friendName, friendTag] = friendString.split('#');

    if (!friendName || !friendTag) return res.status(400).json({ error: 'Формат: Имя#Тег' });

    db.get(`SELECT id FROM users WHERE username = ? AND tag = ?`, [friendName, friendTag], (err, friend) => {
        if (err || !friend) return res.status(404).json({ error: 'Пользователь не найден' });
        if (friend.id === myId) return res.status(400).json({ error: 'Нельзя добавить себя' });

        db.run(`INSERT INTO friends (user_id, friend_id) VALUES (?, ?)`, [myId, friend.id], (err2) => {
            if (err2) return res.status(400).json({ error: 'Уже в друзьях' });
            // Добавляем взаимно
            db.run(`INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)`, [friend.id, myId]);
            res.json({ success: true, friend: { id: friend.id, username: friendName, tag: friendTag } });
        });
    });
});

// Найти пользователя по имени и тегу
app.get('/api/user/find', (req, res) => {
    const { username, tag } = req.query;
    if (!username || !tag) return res.status(400).json({ error: 'Нужны username и tag' });
    db.get(`SELECT id, username, tag FROM users WHERE username = ? AND tag = ?`, [username, tag], (err, user) => {
        if (err || !user) return res.status(404).json({ error: 'Не найден' });
        res.json({ id: String(user.id), username: user.username, tag: user.tag });
    });
});

// Получить список друзей
app.get('/api/friends/:id', (req, res) => {
    const query = `
        SELECT u.id, u.username, u.tag 
        FROM users u 
        JOIN friends f ON u.id = f.friend_id 
        WHERE f.user_id = ?
    `;
    db.all(query, [req.params.id], (err, friends) => {
        if (err) return res.status(500).json({ error: 'Ошибка БД' });
        res.json(friends || []);
    });
});

// Получить историю приватных сообщений
app.get('/api/messages/:userId/:friendId', (req, res) => {
    const { userId, friendId } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    const query = `
        SELECT pm.*, u.username, u.tag 
        FROM private_messages pm
        JOIN users u ON u.id = pm.sender_id
        WHERE (pm.sender_id = ? AND pm.receiver_id = ?) 
           OR (pm.sender_id = ? AND pm.receiver_id = ?)
        ORDER BY pm.created_at ASC
        LIMIT ?
    `;
    db.all(query, [userId, friendId, friendId, userId, limit], (err, messages) => {
        if (err) return res.status(500).json({ error: 'Ошибка БД' });
        res.json(messages || []);
    });
});

// --- WEBSOCKETS ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const onlineUsers = new Map(); // id -> { ws, username, tag }

// Игровые комнаты: roomId -> { players: [id1, id2], board, currentTurn, active, symbol: { id1: 'X', id2: 'O' } }
const gameRooms = new Map();

function send(ws, data) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function broadcastUsersList() {
    db.all(`SELECT id, username, tag FROM users`, [], (err, rows) => {
        if (err) return;
        const allUsers = rows.map(r => ({ id: r.id, full: `${r.username}#${r.tag}` }));
        const onlineIds = Array.from(onlineUsers.keys()).map(id => parseInt(id));
        
        const online = allUsers.filter(u => onlineIds.includes(u.id)).map(u => u.full);
        const offline = allUsers.filter(u => !onlineIds.includes(u.id)).map(u => u.full);

        const message = JSON.stringify({ type: 'users_update', online, offline });
        onlineUsers.forEach((client) => {
            if (client.ws.readyState === WebSocket.OPEN) client.ws.send(message);
        });
    });
}

function createRoom(player1Id, player2Id) {
    const roomId = `room_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const room = {
        id: roomId,
        players: [player1Id, player2Id],
        board: Array(9).fill(''),
        currentTurn: player1Id,
        active: true,
        symbols: { [player1Id]: 'X', [player2Id]: 'O' }
    };
    gameRooms.set(roomId, room);
    return room;
}

const winConditions = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];

function checkWinner(board) {
    for (const [a, b, c] of winConditions) {
        if (board[a] && board[a] === board[b] && board[a] === board[c]) {
            return { winner: board[a], line: [a, b, c] };
        }
    }
    if (!board.includes('')) return { winner: 'draw', line: [] };
    return null;
}

function updateStats(winnerId, loserId, isDraw, players) {
    if (isDraw) {
        players.forEach(pid => {
            db.run(`UPDATE users SET draws = draws + 1 WHERE id = ?`, [pid]);
        });
    } else {
        db.run(`UPDATE users SET wins = wins + 1 WHERE id = ?`, [winnerId]);
        db.run(`UPDATE users SET losses = losses + 1 WHERE id = ?`, [loserId]);
    }
}

wss.on('connection', (ws, req) => {
    const urlParams = new URLSearchParams(req.url.split('?')[1]);
    const id = urlParams.get('id');
    const username = urlParams.get('username');
    const tag = urlParams.get('tag');

    if (!id || !username) { ws.close(); return; }

    onlineUsers.set(id, { ws, username, tag, full: `${username}#${tag}`, currentRoom: null });
    broadcastUsersList();

    ws.on('message', (message) => {
        let data;
        try { data = JSON.parse(message); } catch(e) { return; }
        const sender = onlineUsers.get(id);
        if (!sender) return;

        switch (data.type) {
            // --- ОБЩИЙ ЧАТ ---
            case 'message': {
                const broadcastData = JSON.stringify({ type: 'message', user: sender.full, text: data.text, userId: id });
                onlineUsers.forEach(client => {
                    if (client.ws.readyState === WebSocket.OPEN) client.ws.send(broadcastData);
                });
                break;
            }
            case 'typing':
            case 'stop_typing': {
                const broadcastData = JSON.stringify({ type: data.type, user: sender.full });
                onlineUsers.forEach((client, clientId) => {
                    if (clientId !== id && client.ws.readyState === WebSocket.OPEN) client.ws.send(broadcastData);
                });
                break;
            }

            // --- ПРИВАТНЫЕ СООБЩЕНИЯ ---
            case 'private_message': {
                const { targetId, content, msgType } = data;
                // msgType: 'text', 'voice', 'gif'
                
                // Сохраняем в БД
                db.run(
                    `INSERT INTO private_messages (sender_id, receiver_id, content, msg_type) VALUES (?, ?, ?, ?)`,
                    [parseInt(id), parseInt(targetId), content, msgType || 'text'],
                    function(err) {
                        if (err) { send(ws, { type: 'error', msg: 'Ошибка отправки сообщения' }); return; }
                        
                        const msgPayload = {
                            type: 'private_message',
                            id: this.lastID,
                            senderId: id,
                            senderName: sender.full,
                            receiverId: targetId,
                            content,
                            msgType: msgType || 'text',
                            createdAt: new Date().toISOString()
                        };
                        
                        // Отправляем обоим
                        send(ws, msgPayload);
                        const target = onlineUsers.get(String(targetId));
                        if (target) send(target.ws, msgPayload);
                    }
                );
                break;
            }

            case 'private_typing':
            case 'private_stop_typing': {
                const target = onlineUsers.get(String(data.targetId));
                if (target) {
                    send(target.ws, { 
                        type: data.type, 
                        senderId: id, 
                        senderName: sender.full 
                    });
                }
                break;
            }

            // --- ЗВОНКИ (WebRTC сигнализация) ---
            case 'call_offer': {
                const target = onlineUsers.get(String(data.targetId));
                if (!target) { send(ws, { type: 'call_error', msg: 'Пользователь не в сети' }); break; }
                send(target.ws, {
                    type: 'call_offer',
                    fromId: id,
                    fromName: sender.full,
                    offer: data.offer,
                    callType: data.callType // 'audio' или 'video'
                });
                break;
            }

            case 'call_answer': {
                const target = onlineUsers.get(String(data.targetId));
                if (target) {
                    send(target.ws, {
                        type: 'call_answer',
                        fromId: id,
                        answer: data.answer
                    });
                }
                break;
            }

            case 'call_ice_candidate': {
                const target = onlineUsers.get(String(data.targetId));
                if (target) {
                    send(target.ws, {
                        type: 'call_ice_candidate',
                        fromId: id,
                        candidate: data.candidate
                    });
                }
                break;
            }

            case 'call_decline': {
                const target = onlineUsers.get(String(data.targetId));
                if (target) {
                    send(target.ws, {
                        type: 'call_declined',
                        fromId: id,
                        fromName: sender.full
                    });
                }
                break;
            }

            case 'call_end': {
                const target = onlineUsers.get(String(data.targetId));
                if (target) {
                    send(target.ws, {
                        type: 'call_ended',
                        fromId: id
                    });
                }
                break;
            }

            // --- ИГРОВЫЕ ПРИГЛАШЕНИЯ ---
            case 'game_invite': {
                const target = onlineUsers.get(String(data.targetId));
                if (!target) { send(ws, { type: 'game_error', msg: 'Игрок не в сети' }); break; }
                if (target.currentRoom) { send(ws, { type: 'game_error', msg: 'Игрок уже в игре' }); break; }
                
                send(target.ws, {
                    type: 'game_invite',
                    fromId: id,
                    fromName: sender.full
                });
                send(ws, { type: 'invite_sent', toName: target.full });
                break;
            }

            case 'game_invite_accept': {
                const inviter = onlineUsers.get(String(data.fromId));
                if (!inviter) { send(ws, { type: 'game_error', msg: 'Игрок вышел' }); break; }

                const room = createRoom(data.fromId, id);

                onlineUsers.get(String(data.fromId)).currentRoom = room.id;
                sender.currentRoom = room.id;

                const startPayload = (playerId) => ({
                    type: 'game_start',
                    roomId: room.id,
                    symbol: room.symbols[playerId],
                    opponentName: playerId === data.fromId ? sender.full : inviter.full,
                    yourTurn: room.currentTurn === playerId,
                    board: room.board
                });

                send(inviter.ws, startPayload(data.fromId));
                send(ws, startPayload(id));
                break;
            }

            case 'game_invite_decline': {
                const inviter = onlineUsers.get(String(data.fromId));
                if (inviter) send(inviter.ws, { type: 'invite_declined', byName: sender.full });
                break;
            }

            // --- ИГРОВЫЕ ХОДЫ ---
            case 'game_move': {
                const room = gameRooms.get(data.roomId);
                if (!room || !room.active) break;
                if (room.currentTurn !== id) { send(ws, { type: 'game_error', msg: 'Не ваш ход!' }); break; }
                
                const cellIdx = data.cellIndex;
                if (room.board[cellIdx] !== '') { send(ws, { type: 'game_error', msg: 'Клетка занята' }); break; }

                room.board[cellIdx] = room.symbols[id];
                const result = checkWinner(room.board);

                const otherPlayerId = room.players.find(p => p !== id);
                room.currentTurn = otherPlayerId;

                const movePayload = {
                    type: 'game_update',
                    roomId: room.id,
                    board: room.board,
                    lastMove: cellIdx,
                    currentTurn: room.currentTurn,
                    result: result
                };

                room.players.forEach(pid => {
                    const p = onlineUsers.get(String(pid));
                    if (p) send(p.ws, { ...movePayload, yourTurn: room.currentTurn === pid });
                });

                if (result) {
                    room.active = false;
                    const winnerId = result.winner !== 'draw' 
                        ? room.players.find(p => room.symbols[p] === result.winner)
                        : null;
                    const loserId = winnerId ? room.players.find(p => p !== winnerId) : null;
                    
                    updateStats(winnerId, loserId, result.winner === 'draw', room.players);

                    // НЕ удаляем комнату и НЕ обнуляем currentRoom — нужно для реванша
                }
                break;
            }

            case 'game_rematch': {
                const room = gameRooms.get(data.roomId);
                if (!room) break;

                const otherPlayerId = room.players.find(p => p !== id);
                const other = onlineUsers.get(String(otherPlayerId));
                if (other) send(other.ws, { type: 'rematch_request', fromId: id, roomId: data.roomId });
                break;
            }

            case 'game_rematch_accept': {
                const oldRoom = gameRooms.get(data.roomId);
                if (!oldRoom) break;

                const [p1, p2] = oldRoom.players;
                // Очищаем старую комнату
                gameRooms.delete(data.roomId);

                const room = createRoom(p2, p1);

                const p1User = onlineUsers.get(String(p1));
                const p2User = onlineUsers.get(String(p2));
                if (p1User) p1User.currentRoom = room.id;
                if (p2User) p2User.currentRoom = room.id;

                const startPayload = (playerId) => ({
                    type: 'game_start',
                    roomId: room.id,
                    symbol: room.symbols[playerId],
                    opponentName: playerId === p1 
                        ? onlineUsers.get(String(p2))?.full 
                        : onlineUsers.get(String(p1))?.full,
                    yourTurn: room.currentTurn === playerId,
                    board: room.board
                });

                [p1, p2].forEach(pid => {
                    const p = onlineUsers.get(String(pid));
                    if (p) send(p.ws, startPayload(pid));
                });
                break;
            }

            case 'game_leave': {
                const room = gameRooms.get(data.roomId);
                if (!room) break;
                room.active = false;
                const otherId = room.players.find(p => p !== id);
                const other = onlineUsers.get(String(otherId));
                if (other) {
                    send(other.ws, { type: 'opponent_left' });
                    other.currentRoom = null;
                }
                sender.currentRoom = null;
                gameRooms.delete(data.roomId);
                break;
            }
        }
    });

    ws.on('close', () => {
        const user = onlineUsers.get(id);
        if (user && user.currentRoom) {
            const room = gameRooms.get(user.currentRoom);
            if (room) {
                room.active = false;
                const otherId = room.players.find(p => p !== id);
                const other = onlineUsers.get(String(otherId));
                if (other) {
                    send(other.ws, { type: 'opponent_left' });
                    other.currentRoom = null;
                }
                gameRooms.delete(user.currentRoom);
            }
        }
        onlineUsers.delete(id);
        broadcastUsersList();
    });
});

server.listen(3000, '0.0.0.0', () => console.log('Сервер запущен: http://localhost:3000'));