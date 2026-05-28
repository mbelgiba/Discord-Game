// =============================================
//  XO ARENA — CLIENT APP
// =============================================

let socket = null;
let currentUser = { id: null, username: '', tag: '', bio: '', wins: 0, losses: 0, draws: 0 };
let pendingInviteFrom = null; // { id, name }
let activeRoom = { id: null, mySymbol: null, opponentName: null, myTurn: false };
let onlineUserIds = new Set();

// ===== TOAST SYSTEM =====
function showToast(msg, type = 'info', duration = 3500) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icons = { success: '✅', error: '❌', info: 'ℹ️' };
    toast.textContent = `${icons[type] || ''} ${msg}`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.classList.add('out');
        setTimeout(() => toast.remove(), 350);
    }, duration);
}

// ===== AUTH =====
const authMode = { current: 'login' };

document.getElementById('tab-login').addEventListener('click', () => {
    authMode.current = 'login';
    document.getElementById('tab-login').classList.add('active');
    document.getElementById('tab-register').classList.remove('active');
    document.getElementById('auth-submit-btn').textContent = 'Войти';
});

document.getElementById('tab-register').addEventListener('click', () => {
    authMode.current = 'register';
    document.getElementById('tab-register').classList.add('active');
    document.getElementById('tab-login').classList.remove('active');
    document.getElementById('auth-submit-btn').textContent = 'Зарегистрироваться';
});

document.getElementById('auth-submit-btn').addEventListener('click', handleAuth);
document.getElementById('auth-password').addEventListener('keypress', e => { if (e.key === 'Enter') handleAuth(); });

async function handleAuth() {
    const username = document.getElementById('auth-username').value.trim();
    const password = document.getElementById('auth-password').value.trim();
    const errEl = document.getElementById('auth-error');
    errEl.textContent = '';

    if (!username || !password) { errEl.textContent = 'Заполните все поля!'; return; }

    const btn = document.getElementById('auth-submit-btn');
    btn.disabled = true;
    btn.textContent = '...';

    try {
        const res = await fetch(`/api/auth/${authMode.current}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();

        if (res.ok) {
            currentUser = { ...data };
            onLogin();
        } else {
            errEl.textContent = data.error;
        }
    } catch {
        errEl.textContent = 'Нет связи с сервером';
    } finally {
        btn.disabled = false;
        btn.textContent = authMode.current === 'login' ? 'Войти' : 'Зарегистрироваться';
    }
}

function onLogin() {
    document.getElementById('auth-screen').style.display = 'none';
    document.getElementById('app-container').style.display = 'flex';

    const initial = currentUser.username[0].toUpperCase();
    document.getElementById('sidebar-avatar').textContent = initial;
    document.getElementById('my-username').textContent = `${currentUser.username}#${currentUser.tag}`;

    initWebSocket();
    loadFriends();
    showView('chat');
}

// ===== LOGOUT =====
document.getElementById('logout-btn').addEventListener('click', () => {
    if (socket) socket.close();
    socket = null;
    currentUser = { id: null, username: '', tag: '', bio: '', wins: 0, losses: 0, draws: 0 };
    document.getElementById('app-container').style.display = 'none';
    document.getElementById('auth-screen').style.display = 'flex';
    document.getElementById('auth-username').value = '';
    document.getElementById('auth-password').value = '';
    document.getElementById('auth-error').textContent = '';
    document.getElementById('messages-container').innerHTML =
        '<div class="message system"><span>👋 Добро пожаловать в <strong>XO Arena</strong>! Чтобы сыграть с другом — нажми 🎮 напротив его имени в списке справа.</span></div>';
});

// ===== VIEW SWITCHING =====
function showView(view) {
    document.getElementById('view-chat').style.display = view === 'chat' ? 'flex' : 'none';
    document.getElementById('view-game').style.display = view === 'game' ? 'flex' : 'none';
    document.getElementById('nav-chat').classList.toggle('active', view === 'chat');
}

document.getElementById('nav-chat').addEventListener('click', () => showView('chat'));

document.getElementById('leave-game-btn').addEventListener('click', () => {
    if (activeRoom.id) {
        socket.send(JSON.stringify({ type: 'game_leave', roomId: activeRoom.id }));
        activeRoom = { id: null, mySymbol: null, opponentName: null, myTurn: false };
    }
    showLobby();
    showView('chat');
});

document.getElementById('game-back-btn')?.addEventListener('click', () => {
    if (activeRoom.id) {
        socket.send(JSON.stringify({ type: 'game_leave', roomId: activeRoom.id }));
        activeRoom = { id: null, mySymbol: null, opponentName: null, myTurn: false };
    }
    showLobby();
    showView('chat');
});

// ===== WEBSOCKET =====
function initWebSocket() {
    const params = `?id=${currentUser.id}&username=${encodeURIComponent(currentUser.username)}&tag=${currentUser.tag}`;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${proto}://${location.host}${params}`);

    socket.onmessage = (event) => {
        let data;
        try { data = JSON.parse(event.data); } catch { return; }
        handleWsMessage(data);
    };

    socket.onclose = () => {
        setTimeout(() => {
            if (currentUser.id) initWebSocket();
        }, 3000);
    };
}

function wsSend(obj) {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(obj));
}

function handleWsMessage(data) {
    switch (data.type) {
        case 'users_update':
            updateUserLists(data.online, data.offline);
            break;
        case 'message':
            appendMessage(data.user, data.text, data.userId === String(currentUser.id));
            break;
        case 'typing':
            document.getElementById('typing-indicator').textContent = `${data.user} печатает...`;
            break;
        case 'stop_typing':
            document.getElementById('typing-indicator').textContent = '';
            break;

        // --- GAME INVITE ---
        case 'game_invite':
            pendingInviteFrom = { id: data.fromId, name: data.fromName };
            document.getElementById('invite-title').textContent = `${data.fromName} зовёт играть!`;
            document.getElementById('invite-text').textContent = 'Принять вызов на крестики-нолики?';
            document.getElementById('invite-modal').style.display = 'flex';
            break;
        case 'invite_sent':
            showToast(`Приглашение отправлено → ${data.toName}`, 'info');
            break;
        case 'invite_declined':
            showToast(`${data.byName} отклонил приглашение`, 'error');
            break;

        // --- GAME ---
        case 'game_start':
            activeRoom.id = data.roomId;
            activeRoom.mySymbol = data.symbol;
            activeRoom.opponentName = data.opponentName;
            activeRoom.myTurn = data.yourTurn;
            startGame(data);
            break;
        case 'game_update':
            handleGameUpdate(data);
            break;
        case 'game_error':
            showToast(data.msg, 'error');
            break;
        case 'rematch_request':
            pendingInviteFrom = { id: data.fromId, rematch: true, roomId: data.roomId };
            document.getElementById('invite-title').textContent = 'Реванш!';
            document.getElementById('invite-text').textContent = `${activeRoom.opponentName} хочет сыграть ещё раз`;
            document.getElementById('invite-modal').style.display = 'flex';
            break;
        case 'opponent_left':
            showToast('Соперник вышел из игры', 'error');
            document.getElementById('game-actions').style.display = 'flex';
            document.getElementById('rematch-btn').style.display = 'none';
            setStatusBanner('Соперник покинул игру', '#f87171');
            activeRoom.id = null;
            break;
    }
}

// ===== INVITE MODAL =====
document.getElementById('invite-accept-btn').addEventListener('click', () => {
    document.getElementById('invite-modal').style.display = 'none';
    if (!pendingInviteFrom) return;

    if (pendingInviteFrom.rematch) {
        wsSend({ type: 'game_rematch_accept', roomId: pendingInviteFrom.roomId });
    } else {
        wsSend({ type: 'game_invite_accept', fromId: pendingInviteFrom.id });
    }
    pendingInviteFrom = null;
});

document.getElementById('invite-decline-btn').addEventListener('click', () => {
    document.getElementById('invite-modal').style.display = 'none';
    if (pendingInviteFrom && !pendingInviteFrom.rematch) {
        wsSend({ type: 'game_invite_decline', fromId: pendingInviteFrom.id });
    }
    pendingInviteFrom = null;
});

// ===== CHAT =====
function appendMessage(user, text, isOwn = false) {
    const container = document.getElementById('messages-container');
    const div = document.createElement('div');
    div.className = `message${isOwn ? ' own' : ''}`;
    div.innerHTML = `<div class="msg-author">${user}</div>${escapeHtml(text)}`;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

function escapeHtml(str) {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

document.getElementById('send-btn').addEventListener('click', sendMessage);
document.getElementById('message-input').addEventListener('keypress', e => { if (e.key === 'Enter') sendMessage(); });

let typingTimeout;
document.getElementById('message-input').addEventListener('input', () => {
    wsSend({ type: 'typing' });
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => wsSend({ type: 'stop_typing' }), 1500);
});

function sendMessage() {
    const input = document.getElementById('message-input');
    const text = input.value.trim();
    if (!text || !socket) return;
    wsSend({ type: 'message', text });
    input.value = '';
    wsSend({ type: 'stop_typing' });
    clearTimeout(typingTimeout);
}

// ===== USER LISTS =====
function updateUserLists(online, offline) {
    onlineUserIds.clear();
    const onlineEl = document.getElementById('online-users');
    const offlineEl = document.getElementById('offline-users');
    const myFull = `${currentUser.username}#${currentUser.tag}`;

    // Parse online users to extract IDs from server broadcast
    onlineEl.innerHTML = online.map(fullName => {
        const isMe = fullName === myFull;
        return `
        <li data-full="${fullName}" class="${isMe ? 'me' : ''}">
            <span class="status-dot-indicator online"></span>
            <span class="user-name-text">${fullName}</span>
            ${!isMe ? `<button class="invite-game-btn" title="Пригласить в игру" data-full="${fullName}">🎮</button>` : ''}
        </li>`;
    }).join('');

    offlineEl.innerHTML = offline.map(fullName => `
        <li>
            <span class="status-dot-indicator offline"></span>
            <span class="user-name-text">${fullName}</span>
        </li>`
    ).join('');

    const count = online.length;
    document.getElementById('online-count').textContent = `${count} онлайн`;

    // Attach invite buttons
    onlineEl.querySelectorAll('.invite-game-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const targetFull = btn.dataset.full;
            inviteUserByName(targetFull);
        });
    });
}

// We need to look up user ID by name — server knows IDs, we need to send by ID
// We'll resolve via the friends list cache or a simple lookup request
const userNameToId = new Map(); // populated when we get friends or via profile search

function inviteUserByName(fullName) {
    // Try to find ID from friends cache
    const cached = userNameToId.get(fullName);
    if (cached) {
        wsSend({ type: 'game_invite', targetId: cached });
        showToast(`Приглашение отправлено → ${fullName}`, 'info');
    } else {
        // Lookup by username#tag
        const [uname, utag] = fullName.split('#');
        fetch(`/api/user/find?username=${encodeURIComponent(uname)}&tag=${encodeURIComponent(utag)}`)
            .then(r => r.json())
            .then(data => {
                if (data.id) {
                    userNameToId.set(fullName, data.id);
                    wsSend({ type: 'game_invite', targetId: data.id });
                    showToast(`Приглашение отправлено → ${fullName}`, 'info');
                } else {
                    showToast('Не удалось найти игрока', 'error');
                }
            })
            .catch(() => showToast('Ошибка поиска игрока', 'error'));
    }
}

// ===== FRIENDS =====
async function loadFriends() {
    const res = await fetch(`/api/friends/${currentUser.id}`);
    if (!res.ok) return;
    const friends = await res.json();
    const list = document.getElementById('friends-list');
    list.innerHTML = friends.map(f => {
        const full = `${f.username}#${f.tag}`;
        userNameToId.set(full, String(f.id));
        return `<li class="nav-item" data-id="${f.id}" data-full="${full}">👥 ${full}</li>`;
    }).join('') || '<li style="color:var(--muted);font-size:13px;padding:8px">Список пуст</li>';
}

document.getElementById('add-friend-btn').addEventListener('click', addFriend);
document.getElementById('friend-search-input').addEventListener('keypress', e => { if (e.key === 'Enter') addFriend(); });

async function addFriend() {
    const input = document.getElementById('friend-search-input');
    const errEl = document.getElementById('friend-error');
    const friendString = input.value.trim();
    errEl.textContent = '';
    if (!friendString.includes('#')) { errEl.textContent = 'Формат: Имя#Тег'; return; }

    const res = await fetch('/api/friends/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ myId: currentUser.id, friendString })
    });
    const data = await res.json();

    if (res.ok) {
        input.value = '';
        showToast(`${friendString} добавлен в друзья!`, 'success');
        loadFriends();
    } else {
        errEl.textContent = data.error;
    }
}

// ===== PROFILE MODAL =====
document.getElementById('open-profile-btn').addEventListener('click', async () => {
    document.getElementById('modal-username-display').textContent = `${currentUser.username}#${currentUser.tag}`;
    document.getElementById('modal-avatar-badge').textContent = currentUser.username[0].toUpperCase();
    document.getElementById('profile-msg').textContent = '';

    const res = await fetch(`/api/profile/${currentUser.id}`);
    if (res.ok) {
        const d = await res.json();
        currentUser = { ...currentUser, ...d };
        document.getElementById('profile-bio-input').value = d.bio || '';
        document.getElementById('stat-wins').textContent = d.wins || 0;
        document.getElementById('stat-losses').textContent = d.losses || 0;
        document.getElementById('stat-draws').textContent = d.draws || 0;
    }
    document.getElementById('profile-modal').style.display = 'flex';
});

document.getElementById('close-profile-btn').addEventListener('click', () => {
    document.getElementById('profile-modal').style.display = 'none';
});

document.getElementById('save-profile-btn').addEventListener('click', async () => {
    const bio = document.getElementById('profile-bio-input').value.trim();
    const res = await fetch('/api/profile/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: currentUser.id, bio })
    });
    if (res.ok) {
        currentUser.bio = bio;
        document.getElementById('profile-msg').textContent = 'Сохранено!';
        setTimeout(() => {
            document.getElementById('profile-msg').textContent = '';
            document.getElementById('profile-modal').style.display = 'none';
        }, 1200);
    }
});

// ===== GAME =====
function showLobby() {
    document.getElementById('game-lobby').style.display = 'flex';
    document.getElementById('game-active').style.display = 'none';
    document.getElementById('game-actions').style.display = 'none';
}

function startGame(data) {
    showView('game');
    document.getElementById('game-lobby').style.display = 'none';
    document.getElementById('game-active').style.display = 'flex';
    document.getElementById('game-actions').style.display = 'none';
    document.getElementById('rematch-btn').style.display = '';

    // Set symbols
    const mySymBadge = document.getElementById('my-symbol-badge');
    const oppSymBadge = document.getElementById('opp-symbol-badge');
    mySymBadge.textContent = data.symbol;
    mySymBadge.className = `player-symbol ${data.symbol.toLowerCase()}`;
    const oppSym = data.symbol === 'X' ? 'O' : 'X';
    oppSymBadge.textContent = oppSym;
    oppSymBadge.className = `player-symbol ${oppSym.toLowerCase()}`;

    document.getElementById('player-me-name').textContent = `${currentUser.username}`;
    document.getElementById('player-opp-name').textContent = data.opponentName?.split('#')[0] || 'Соперник';

    resetBoard(data.board);
    updateTurnUI(data.yourTurn, data.symbol);

    showToast(`Игра началась! Вы играете за ${data.symbol}`, 'success');
}

function resetBoard(board = Array(9).fill('')) {
    const cells = document.querySelectorAll('.cell');
    cells.forEach((cell, i) => {
        cell.textContent = board[i] || '';
        cell.className = 'cell';
        if (board[i]) {
            cell.classList.add(board[i].toLowerCase(), 'taken');
        }
        cell.onclick = () => handleCellClick(i);
    });
}

function handleCellClick(idx) {
    if (!activeRoom.myTurn || !activeRoom.id) return;
    const cell = document.querySelector(`.cell[data-index="${idx}"]`);
    if (!cell || cell.classList.contains('taken')) return;
    wsSend({ type: 'game_move', roomId: activeRoom.id, cellIndex: idx });
}

function handleGameUpdate(data) {
    const { board, currentTurn, result, yourTurn } = data;
    activeRoom.myTurn = yourTurn;

    // Update board
    const cells = document.querySelectorAll('.cell');
    cells.forEach((cell, i) => {
        if (board[i] && !cell.classList.contains('taken')) {
            cell.textContent = board[i];
            cell.className = `cell taken ${board[i].toLowerCase()} pop-in`;
            // remove animation class after it's done
            setTimeout(() => cell.classList.remove('pop-in'), 300);
        }
    });

    if (result) {
        // Game over
        activeRoom.myTurn = false;
        if (result.winner === 'draw') {
            setStatusBanner('🤝 Ничья!', '#c084fc');
            showToast('Ничья!', 'info');
        } else {
            const iWon = result.winner === activeRoom.mySymbol;
            result.line.forEach(idx => {
                cells[idx].classList.add('winning');
            });
            if (iWon) {
                setStatusBanner('🏆 Вы победили!', '#4ade80');
                showToast('Вы победили! 🏆', 'success');
            } else {
                setStatusBanner('💀 Вы проиграли', '#f87171');
                showToast('Вы проиграли...', 'error');
            }
        }
        // Refresh stats
        fetch(`/api/profile/${currentUser.id}`).then(r => r.json()).then(d => {
            currentUser = { ...currentUser, ...d };
        });

        document.getElementById('game-actions').style.display = 'flex';
        activeRoom.id = null; // room closed
    } else {
        updateTurnUI(yourTurn, activeRoom.mySymbol);
    }
}

function updateTurnUI(myTurn, mySymbol) {
    const statusText = myTurn ? `Ваш ход (${mySymbol})` : 'Ход соперника...';
    const color = myTurn ? (mySymbol === 'X' ? '#f87171' : '#60a5fa') : '#7c6fa0';
    setStatusBanner(statusText, color);

    const meCard = document.getElementById('player-me-card');
    const oppCard = document.getElementById('player-opp-card');
    meCard.classList.toggle('active-turn', myTurn);
    oppCard.classList.toggle('active-turn', !myTurn);
}

function setStatusBanner(text, color) {
    document.getElementById('game-status-text').textContent = text;
    const dot = document.getElementById('status-dot');
    dot.style.background = color;
    dot.style.boxShadow = `0 0 8px ${color}`;
}

// Rematch button
document.getElementById('rematch-btn').addEventListener('click', () => {
    if (activeRoom.id) {
        wsSend({ type: 'game_rematch', roomId: activeRoom.id });
        showToast('Запрос на реванш отправлен!', 'info');
        document.getElementById('rematch-btn').disabled = true;
        document.getElementById('rematch-btn').textContent = '⏳ Ожидание...';
    }
});