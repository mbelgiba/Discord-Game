// =============================================
//  XO ARENA — CLIENT APP (WITH DMS, CALLS, MEDIA)
// =============================================

let socket = null;
let currentUser = { id: null, username: '', tag: '', bio: '', wins: 0, losses: 0, draws: 0 };
let pendingInviteFrom = null; // { id, name, rematch, roomId }
let activeRoom = { id: null, mySymbol: null, opponentName: null, myTurn: false };
let onlineUserIds = new Set();
let userNameToId = new Map(); // Full name to ID mapping

// DM State
let currentDmPartner = null; // { id, name }

// Call State
let localStream = null;
let peerConnection = null;
let activeCallPartner = null;
let callType = null; // 'audio' or 'video'
let incomingCallFrom = null;

const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

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

document.getElementById('logout-btn').addEventListener('click', () => {
    if (socket) socket.close();
    socket = null;
    currentUser = { id: null, username: '', tag: '', bio: '', wins: 0, losses: 0, draws: 0 };
    document.getElementById('app-container').style.display = 'none';
    document.getElementById('auth-screen').style.display = 'flex';
});

// ===== VIEW SWITCHING =====
function showView(view) {
    document.getElementById('view-chat').style.display = view === 'chat' ? 'flex' : 'none';
    document.getElementById('view-dm').style.display = view === 'dm' ? 'flex' : 'none';
    document.getElementById('view-game').style.display = view === 'game' ? 'flex' : 'none';
    
    document.getElementById('nav-chat').classList.toggle('active', view === 'chat');
    
    if (view !== 'dm') {
        currentDmPartner = null;
        document.querySelectorAll('.friends-list .nav-item').forEach(el => el.classList.remove('active'));
    }
}

document.getElementById('nav-chat').addEventListener('click', () => showView('chat'));
document.getElementById('dm-back-btn').addEventListener('click', () => showView('chat'));

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
        setTimeout(() => { if (currentUser.id) initWebSocket(); }, 3000);
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
            appendMessage('messages-container', data.user, data.text, data.userId === String(currentUser.id));
            break;
        case 'typing':
            document.getElementById('typing-indicator').textContent = `${data.user} печатает...`;
            break;
        case 'stop_typing':
            document.getElementById('typing-indicator').textContent = '';
            break;
            
        // DM
        case 'private_message':
            if (currentDmPartner && (String(data.senderId) === String(currentDmPartner.id) || String(data.receiverId) === String(currentDmPartner.id))) {
                appendDmMessage(data.senderName, data.content, data.msgType, String(data.senderId) === String(currentUser.id));
            } else {
                if (String(data.senderId) !== String(currentUser.id)) {
                    showToast(`Новое сообщение от ${data.senderName}`, 'info');
                }
            }
            break;
        case 'private_typing':
            if (currentDmPartner && String(data.senderId) === String(currentDmPartner.id)) {
                document.getElementById('dm-typing-indicator').textContent = `${data.senderName} печатает...`;
            }
            break;
        case 'private_stop_typing':
            if (currentDmPartner && String(data.senderId) === String(currentDmPartner.id)) {
                document.getElementById('dm-typing-indicator').textContent = '';
            }
            break;

        // CALLS
        case 'call_offer':
            handleCallOffer(data);
            break;
        case 'call_answer':
            handleCallAnswer(data);
            break;
        case 'call_ice_candidate':
            handleIceCandidate(data);
            break;
        case 'call_declined':
            handleCallDeclined(data);
            break;
        case 'call_ended':
            endCallLocally();
            break;

        // GAME INVITE
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

        // GAME
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

// ===== FRIENDS & DMS =====
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

    list.querySelectorAll('.nav-item').forEach(li => {
        li.addEventListener('click', () => openDM(li.dataset.id, li.dataset.full, li));
    });
}

function openDM(id, fullName, el) {
    document.querySelectorAll('.nav-list .nav-item').forEach(item => item.classList.remove('active'));
    if (el) el.classList.add('active');
    
    currentDmPartner = { id, name: fullName };
    document.getElementById('dm-partner-name').textContent = fullName;
    showView('dm');
    loadDmMessages(id);
}

async function loadDmMessages(friendId) {
    const container = document.getElementById('dm-messages-container');
    container.innerHTML = '';
    const res = await fetch(`/api/messages/${currentUser.id}/${friendId}`);
    if (res.ok) {
        const msgs = await res.json();
        msgs.forEach(m => {
            const isOwn = String(m.sender_id) === String(currentUser.id);
            const senderName = isOwn ? `${currentUser.username}#${currentUser.tag}` : `${m.username}#${m.tag}`;
            appendDmMessage(senderName, m.content, m.msg_type, isOwn);
        });
    }
}

function appendDmMessage(user, content, type, isOwn) {
    const container = document.getElementById('dm-messages-container');
    const div = document.createElement('div');
    div.className = `message${isOwn ? ' own' : ''}`;
    
    let innerHTML = `<div class="msg-author">${user}</div>`;
    
    if (type === 'text') {
        innerHTML += escapeHtml(content);
    } else if (type === 'gif') {
        innerHTML += `<img src="${escapeHtml(content)}" class="message-gif" alt="GIF">`;
    } else if (type === 'voice') {
        innerHTML += `<audio controls class="message-audio" src="${content}"></audio>`;
    }
    
    div.innerHTML = innerHTML;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

// Global Chat
document.getElementById('send-btn').addEventListener('click', sendGlobalMessage);
document.getElementById('message-input').addEventListener('keypress', e => { if (e.key === 'Enter') sendGlobalMessage(); });

function sendGlobalMessage() {
    const input = document.getElementById('message-input');
    const text = input.value.trim();
    if (!text || !socket) return;
    wsSend({ type: 'message', text });
    input.value = '';
    wsSend({ type: 'stop_typing' });
}

// DM Chat
document.getElementById('dm-send-btn').addEventListener('click', sendDmMessage);
document.getElementById('dm-message-input').addEventListener('keypress', e => { if (e.key === 'Enter') sendDmMessage(); });

let dmTypingTimeout;
document.getElementById('dm-message-input').addEventListener('input', () => {
    if (!currentDmPartner) return;
    wsSend({ type: 'private_typing', targetId: currentDmPartner.id });
    clearTimeout(dmTypingTimeout);
    dmTypingTimeout = setTimeout(() => wsSend({ type: 'private_stop_typing', targetId: currentDmPartner.id }), 1500);
});

function sendDmMessage() {
    if (!currentDmPartner) return;
    const input = document.getElementById('dm-message-input');
    const text = input.value.trim();
    if (!text) return;
    wsSend({ type: 'private_message', targetId: currentDmPartner.id, content: text, msgType: 'text' });
    input.value = '';
    wsSend({ type: 'private_stop_typing', targetId: currentDmPartner.id });
}

function escapeHtml(str) { return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function appendMessage(containerId, user, text, isOwn = false) {
    const container = document.getElementById(containerId);
    const div = document.createElement('div');
    div.className = `message${isOwn ? ' own' : ''}`;
    div.innerHTML = `<div class="msg-author">${user}</div>${escapeHtml(text)}`;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

// ===== VOICE MESSAGES =====
let mediaRecorder;
let audioChunks = [];
let voiceTimerInterval;
let voiceStartTime;

document.getElementById('dm-voice-btn').addEventListener('click', async () => {
    if (mediaRecorder && mediaRecorder.state === 'recording') return;
    
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream);
        audioChunks = [];
        
        mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
        mediaRecorder.onstop = () => {
            stream.getTracks().forEach(track => track.stop());
            if (audioChunks.length === 0) return;
            const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
            
            // Convert to base64
            const reader = new FileReader();
            reader.readAsDataURL(audioBlob);
            reader.onloadend = () => {
                const base64data = reader.result;
                if (currentDmPartner) {
                    wsSend({ type: 'private_message', targetId: currentDmPartner.id, content: base64data, msgType: 'voice' });
                }
            };
        };
        
        mediaRecorder.start();
        document.getElementById('dm-message-input').style.display = 'none';
        document.getElementById('dm-send-btn').style.display = 'none';
        document.getElementById('dm-voice-btn').classList.add('recording');
        document.getElementById('voice-recording-bar').style.display = 'flex';
        
        voiceStartTime = Date.now();
        voiceTimerInterval = setInterval(() => {
            const diff = Math.floor((Date.now() - voiceStartTime) / 1000);
            const mins = Math.floor(diff / 60);
            const secs = (diff % 60).toString().padStart(2, '0');
            document.getElementById('voice-timer').textContent = `${mins}:${secs}`;
        }, 1000);
        
    } catch (e) {
        showToast('Не удалось получить доступ к микрофону', 'error');
    }
});

document.getElementById('voice-cancel-btn').addEventListener('click', stopRecording.bind(null, false));
document.getElementById('voice-send-btn').addEventListener('click', stopRecording.bind(null, true));

function stopRecording(sendData) {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        if (!sendData) audioChunks = []; // clear to prevent sending
        mediaRecorder.stop();
    }
    clearInterval(voiceTimerInterval);
    document.getElementById('dm-message-input').style.display = 'block';
    document.getElementById('dm-send-btn').style.display = 'flex';
    document.getElementById('dm-voice-btn').classList.remove('recording');
    document.getElementById('voice-recording-bar').style.display = 'none';
    document.getElementById('voice-timer').textContent = '0:00';
}

// ===== GIFS (Dummy data for demo, typically requires Giphy API) =====
const sampleGifs = [
    'https://media.giphy.com/media/ICOgUNjpvO0PC/giphy.gif',
    'https://media.giphy.com/media/JIX9t2j0ZTN9S/giphy.gif',
    'https://media.giphy.com/media/mlvseq9yvZhba/giphy.gif',
    'https://media.giphy.com/media/3o7TKSjRrfIPjeiVyM/giphy.gif',
    'https://media.giphy.com/media/l41lFw057lAJQMwg0/giphy.gif',
    'https://media.giphy.com/media/3oriO0OEd9QIDdllqo/giphy.gif'
];

document.getElementById('dm-gif-btn').addEventListener('click', () => {
    document.getElementById('gif-modal').style.display = 'flex';
    renderGifs(sampleGifs);
});
document.getElementById('close-gif-btn').addEventListener('click', () => {
    document.getElementById('gif-modal').style.display = 'none';
});

function renderGifs(urls) {
    const container = document.getElementById('gif-results');
    container.innerHTML = '';
    urls.forEach(url => {
        const img = document.createElement('img');
        img.src = url;
        img.className = 'gif-item';
        img.onclick = () => {
            if (currentDmPartner) {
                wsSend({ type: 'private_message', targetId: currentDmPartner.id, content: url, msgType: 'gif' });
            }
            document.getElementById('gif-modal').style.display = 'none';
        };
        container.appendChild(img);
    });
}

// ===== CALLS (WebRTC) =====
document.getElementById('dm-call-audio-btn').addEventListener('click', () => startCall('audio'));
document.getElementById('dm-call-video-btn').addEventListener('click', () => startCall('video'));

async function startCall(type) {
    if (!currentDmPartner) return;
    callType = type;
    activeCallPartner = currentDmPartner;
    
    showCallUI(true, type);
    showToast('Звоним...', 'info');

    try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: type === 'video' });
        document.getElementById('local-video').srcObject = localStream;
        
        peerConnection = new RTCPeerConnection(rtcConfig);
        localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
        
        peerConnection.onicecandidate = e => {
            if (e.candidate) {
                wsSend({ type: 'call_ice_candidate', targetId: activeCallPartner.id, candidate: e.candidate });
            }
        };
        
        peerConnection.ontrack = e => {
            document.getElementById('remote-video').srcObject = e.streams[0];
        };

        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        wsSend({ type: 'call_offer', targetId: activeCallPartner.id, offer, callType: type });
        
    } catch (e) {
        showToast('Ошибка доступа к медиаустройствам', 'error');
        endCallLocally();
    }
}

function handleCallOffer(data) {
    if (activeCallPartner) {
        // Already in call, reject
        wsSend({ type: 'call_decline', targetId: data.fromId });
        return;
    }
    incomingCallFrom = data;
    document.getElementById('call-incoming-title').textContent = data.callType === 'video' ? 'Видеозвонок' : 'Аудиозвонок';
    document.getElementById('call-incoming-text').textContent = `От ${data.fromName}`;
    document.getElementById('call-incoming-modal').style.display = 'flex';
}

document.getElementById('call-accept-btn').addEventListener('click', async () => {
    document.getElementById('call-incoming-modal').style.display = 'none';
    if (!incomingCallFrom) return;
    
    activeCallPartner = { id: incomingCallFrom.fromId, name: incomingCallFrom.fromName };
    callType = incomingCallFrom.callType;
    showCallUI(false, callType);

    try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: callType === 'video' });
        document.getElementById('local-video').srcObject = localStream;

        peerConnection = new RTCPeerConnection(rtcConfig);
        localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

        peerConnection.onicecandidate = e => {
            if (e.candidate) wsSend({ type: 'call_ice_candidate', targetId: activeCallPartner.id, candidate: e.candidate });
        };
        
        peerConnection.ontrack = e => {
            document.getElementById('remote-video').srcObject = e.streams[0];
        };

        await peerConnection.setRemoteDescription(new RTCSessionDescription(incomingCallFrom.offer));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        wsSend({ type: 'call_answer', targetId: activeCallPartner.id, answer });
        
        startCallTimer();
    } catch (e) {
        showToast('Ошибка доступа к камере/микрофону', 'error');
        wsSend({ type: 'call_decline', targetId: incomingCallFrom.fromId });
        endCallLocally();
    }
    incomingCallFrom = null;
});

document.getElementById('call-decline-btn').addEventListener('click', () => {
    document.getElementById('call-incoming-modal').style.display = 'none';
    if (incomingCallFrom) {
        wsSend({ type: 'call_decline', targetId: incomingCallFrom.fromId });
        incomingCallFrom = null;
    }
});

async function handleCallAnswer(data) {
    if (peerConnection) {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
        startCallTimer();
    }
}

async function handleIceCandidate(data) {
    if (peerConnection) {
        try { await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch(e){}
    }
}

function handleCallDeclined(data) {
    showToast('Звонок отклонен', 'error');
    endCallLocally();
}

document.getElementById('call-end-btn').addEventListener('click', () => {
    if (activeCallPartner) wsSend({ type: 'call_end', targetId: activeCallPartner.id });
    endCallLocally();
});

let callTimerInterval;
let callStartTime;
function startCallTimer() {
    callStartTime = Date.now();
    callTimerInterval = setInterval(() => {
        const diff = Math.floor((Date.now() - callStartTime) / 1000);
        const mins = Math.floor(diff / 60).toString().padStart(2, '0');
        const secs = (diff % 60).toString().padStart(2, '0');
        document.getElementById('call-timer').textContent = `${mins}:${secs}`;
    }, 1000);
}

function showCallUI(isCaller, type) {
    document.getElementById('call-overlay').style.display = 'flex';
    document.getElementById('call-partner-name').textContent = activeCallPartner.name;
    document.getElementById('call-timer').textContent = isCaller ? 'Вызов...' : 'Соединение...';
    
    if (type === 'audio') {
        document.getElementById('call-audio-avatar').classList.add('active');
        document.getElementById('remote-video').style.display = 'none';
        document.getElementById('local-video').style.display = 'none';
        document.getElementById('call-toggle-camera').style.display = 'none';
    } else {
        document.getElementById('call-audio-avatar').classList.remove('active');
        document.getElementById('remote-video').style.display = 'block';
        document.getElementById('local-video').style.display = 'block';
        document.getElementById('call-toggle-camera').style.display = 'flex';
    }
}

function endCallLocally() {
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    clearInterval(callTimerInterval);
    document.getElementById('call-overlay').style.display = 'none';
    document.getElementById('remote-video').srcObject = null;
    document.getElementById('local-video').srcObject = null;
    activeCallPartner = null;
}

// Control toggles
document.getElementById('call-toggle-mic').addEventListener('click', (e) => {
    if (localStream) {
        const audioTrack = localStream.getAudioTracks()[0];
        if (audioTrack) {
            audioTrack.enabled = !audioTrack.enabled;
            e.currentTarget.classList.toggle('active', audioTrack.enabled);
        }
    }
});

document.getElementById('call-toggle-camera').addEventListener('click', (e) => {
    if (localStream && callType === 'video') {
        const videoTrack = localStream.getVideoTracks()[0];
        if (videoTrack) {
            videoTrack.enabled = !videoTrack.enabled;
            e.currentTarget.classList.toggle('active', videoTrack.enabled);
        }
    }
});

// ===== USER LISTS =====
function updateUserLists(online, offline) {
    onlineUserIds.clear();
    const onlineEl = document.getElementById('online-users');
    const offlineEl = document.getElementById('offline-users');
    const myFull = `${currentUser.username}#${currentUser.tag}`;

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

    document.getElementById('online-count').textContent = `${online.length} онлайн`;

    onlineEl.querySelectorAll('.invite-game-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            inviteUserByName(btn.dataset.full);
        });
    });
}

function inviteUserByName(fullName) {
    const cached = userNameToId.get(fullName);
    if (cached) {
        wsSend({ type: 'game_invite', targetId: cached });
        showToast(`Приглашение отправлено → ${fullName}`, 'info');
    } else {
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
            }).catch(() => showToast('Ошибка поиска игрока', 'error'));
    }
}

// ===== PROFILE =====
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

document.getElementById('close-profile-btn').addEventListener('click', () => { document.getElementById('profile-modal').style.display = 'none'; });

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
        setTimeout(() => { document.getElementById('profile-modal').style.display = 'none'; }, 1200);
    }
});

// Invite modals
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

// Add friend
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

// ===== GAME =====
function startGame(data) {
    showView('game');
    document.getElementById('game-lobby').style.display = 'none';
    document.getElementById('game-active').style.display = 'flex';
    document.getElementById('game-actions').style.display = 'none';
    document.getElementById('rematch-btn').style.display = '';
    document.getElementById('rematch-btn').disabled = false;
    document.getElementById('rematch-btn').textContent = '🔄 Реванш';

    const mySymBadge = document.getElementById('my-symbol-badge');
    const oppSymBadge = document.getElementById('opp-symbol-badge');
    mySymBadge.textContent = data.symbol;
    mySymBadge.className = `player-symbol ${data.symbol.toLowerCase()}`;
    const oppSym = data.symbol === 'X' ? 'O' : 'X';
    oppSymBadge.textContent = oppSym;
    oppSymBadge.className = `player-symbol ${oppSym.toLowerCase()}`;

    document.getElementById('player-me-name').textContent = currentUser.username;
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
        if (board[i]) cell.classList.add(board[i].toLowerCase(), 'taken');
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
    const { board, result, yourTurn } = data;
    activeRoom.myTurn = yourTurn;

    const cells = document.querySelectorAll('.cell');
    cells.forEach((cell, i) => {
        if (board[i] && !cell.classList.contains('taken')) {
            cell.textContent = board[i];
            cell.className = `cell taken ${board[i].toLowerCase()} pop-in`;
            setTimeout(() => cell.classList.remove('pop-in'), 300);
        }
    });

    if (result) {
        activeRoom.myTurn = false;
        if (result.winner === 'draw') {
            setStatusBanner('🤝 Ничья!', '#c084fc');
        } else {
            const iWon = result.winner === activeRoom.mySymbol;
            result.line.forEach(idx => cells[idx].classList.add('winning'));
            if (iWon) setStatusBanner('🏆 Вы победили!', '#4ade80');
            else setStatusBanner('💀 Вы проиграли', '#f87171');
        }
        fetch(`/api/profile/${currentUser.id}`).then(r => r.json()).then(d => { currentUser = { ...currentUser, ...d }; });
        document.getElementById('game-actions').style.display = 'flex';
        // DO NOT null activeRoom.id here so rematch works
    } else {
        updateTurnUI(yourTurn, activeRoom.mySymbol);
    }
}

function updateTurnUI(myTurn, mySymbol) {
    const statusText = myTurn ? `Ваш ход (${mySymbol})` : 'Ход соперника...';
    const color = myTurn ? (mySymbol === 'X' ? '#f87171' : '#60a5fa') : '#7c6fa0';
    setStatusBanner(statusText, color);

    document.getElementById('player-me-card').classList.toggle('active-turn', myTurn);
    document.getElementById('player-opp-card').classList.toggle('active-turn', !myTurn);
}

function setStatusBanner(text, color) {
    document.getElementById('game-status-text').textContent = text;
    const dot = document.getElementById('status-dot');
    dot.style.background = color;
    dot.style.boxShadow = `0 0 8px ${color}`;
}

document.getElementById('rematch-btn').addEventListener('click', () => {
    if (activeRoom.id) {
        wsSend({ type: 'game_rematch', roomId: activeRoom.id });
        showToast('Запрос на реванш отправлен!', 'info');
        document.getElementById('rematch-btn').disabled = true;
        document.getElementById('rematch-btn').textContent = '⏳ Ожидание...';
    }
});

function leaveGame() {
    if (activeRoom.id) {
        wsSend({ type: 'game_leave', roomId: activeRoom.id });
        activeRoom = { id: null, mySymbol: null, opponentName: null, myTurn: false };
    }
    document.getElementById('game-lobby').style.display = 'flex';
    document.getElementById('game-active').style.display = 'none';
    document.getElementById('game-actions').style.display = 'none';
    showView('chat');
}
document.getElementById('leave-game-btn').addEventListener('click', leaveGame);
document.getElementById('game-back-btn')?.addEventListener('click', leaveGame);