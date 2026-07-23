const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Хранилище комнат: name -> { password, creatorId, viewers: Set, reactions: {} }
const rooms = new Map();

function broadcastLobbies() {
    const lobbies = [];
    rooms.forEach((data, name) => {
        lobbies.push({
            name: name,
            hasPassword: !!data.password,
            viewers: data.viewers.size
        });
    });
    io.emit('update-lobbies', lobbies);
}

io.on('connection', (socket) => {
    // Отправляем список лобби при подключении
    socket.emit('update-lobbies', Array.from(rooms.entries()).map(([name, data]) => ({
        name, hasPassword: !!data.password, viewers: data.viewers.size
    })));

    socket.on('create-room', (roomName, password) => {
        if (rooms.has(roomName)) {
            socket.emit('error-msg', 'Лобби с таким именем (вашим ником) уже существует.');
            return;
        }
        
        socket.join(roomName);
        socket.roomName = roomName;
        socket.userName = roomName; // Имя создателя
        socket.isAdmin = true;

        rooms.set(roomName, {
            password: password || null,
            creatorId: socket.id,
            viewers: new Set([socket.id]),
            reactions: {} // msgId -> { emoji: count }
        });

        socket.emit('room-ready', true);
        broadcastLobbies();
    });

    socket.on('join-room', (roomName, userName, password) => {
        const room = rooms.get(roomName);
        if (!room) {
            socket.emit('error-msg', 'Такого лобби не существует.');
            return;
        }
        
        if (room.password && room.password !== password) {
            socket.emit('error-msg', 'Неверный пароль!');
            return;
        }

        socket.join(roomName);
        socket.roomName = roomName;
        socket.userName = userName;
        socket.isAdmin = false;

        room.viewers.add(socket.id);
        
        socket.emit('room-ready', false);
        socket.to(room.creatorId).emit('user-joined', socket.id, userName);
        broadcastLobbies();
    });

    // --- Чат и Реакции ---
    socket.on('chat-message', (roomName, user, text) => {
        const msgId = Math.random().toString(36).substr(2, 9); // Уникальный ID для реакций
        io.to(roomName).emit('chat-message', { msgId, user, text });
    });

    socket.on('add-reaction', (roomName, msgId, emoji) => {
        const room = rooms.get(roomName);
        if (room) {
            if (!room.reactions[msgId]) room.reactions[msgId] = {};
            if (!room.reactions[msgId][emoji]) room.reactions[msgId][emoji] = 0;
            
            room.reactions[msgId][emoji]++;
            io.to(roomName).emit('update-reactions', msgId, emoji, room.reactions[msgId][emoji]);
        }
    });

    // --- WebRTC Сигналы ---
    socket.on('signal', (toId, signalData) => {
        io.to(toId).emit('signal', socket.id, signalData);
    });

    socket.on('stop-stream-notice', (roomName) => {
        socket.to(roomName).emit('stream-cleared');
    });

    socket.on('kick-user', (targetId) => {
        if (socket.isAdmin) {
            io.to(targetId).emit('kicked-notice');
            io.sockets.sockets.get(targetId)?.disconnect();
        }
    });

    socket.on('disconnect', () => {
        if (socket.roomName) {
            const room = rooms.get(socket.roomName);
            if (room) {
                room.viewers.delete(socket.id);
                
                if (socket.isAdmin) {
                    // Если админ ушел, удаляем комнату
                    socket.to(socket.roomName).emit('error-msg', 'Админ завершил трансляцию и удалил лобби.');
                    rooms.delete(socket.roomName);
                } else {
                    socket.to(room.creatorId).emit('user-left', socket.userName);
                }
                broadcastLobbies();
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
