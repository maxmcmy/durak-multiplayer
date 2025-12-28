// server.js - Durak Multiplayer Server
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Serve static files
app.use(express.static('public'));

// Game rooms storage
const gameRooms = new Map();
const playerRooms = new Map(); // Track which room each player is in

// Card representations
const suits = ['♠', '♥', '♦', '♣'];
const ranks = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const rankValues = {'6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14};

// Create a new deck
function createDeck() {
    const deck = [];
    for (let suit of suits) {
        for (let rank of ranks) {
            deck.push({
                suit: suit,
                rank: rank,
                value: rankValues[rank],
                isTrump: false
            });
        }
    }
    return shuffleDeck(deck);
}

// Shuffle deck
function shuffleDeck(deck) {
    const newDeck = [...deck];
    for (let i = newDeck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [newDeck[i], newDeck[j]] = [newDeck[j], newDeck[i]];
    }
    return newDeck;
}

// Create a new game room
function createRoom(roomCode, creatorId, creatorName) {
    const room = {
        code: roomCode,
        players: [{
            id: creatorId,
            name: creatorName,
            ready: false,
            hand: [],
            connected: true
        }],
        gameState: 'waiting', // waiting, playing, finished
        deck: [],
        battlefield: [],
        trumpCard: null,
        trumpSuit: '',
        currentAttacker: null,
        currentDefender: null,
        gamePhase: 'waiting', // waiting, attacking, defending
        turnTimer: null,
        lastAction: Date.now()
    };
    
    gameRooms.set(roomCode, room);
    playerRooms.set(creatorId, roomCode);
    return room;
}

// Start a game in a room
function startGame(roomCode) {
    const room = gameRooms.get(roomCode);
    if (!room || room.players.length !== 2) return false;
    
    // Initialize game
    room.deck = createDeck();
    room.battlefield = [];
    room.gameState = 'playing';
    room.gamePhase = 'attacking';
    
    // Deal initial cards
    room.players[0].hand = [];
    room.players[1].hand = [];
    
    for (let i = 0; i < 6; i++) {
        room.players[0].hand.push(room.deck.pop());
        room.players[1].hand.push(room.deck.pop());
    }
    
    // Set trump card
    room.trumpCard = room.deck[0];
    room.trumpSuit = room.trumpCard.suit;
    
    // Mark trump cards
    [...room.deck, ...room.players[0].hand, ...room.players[1].hand].forEach(card => {
        card.isTrump = card.suit === room.trumpSuit;
    });
    
    // Determine first attacker (player with lowest trump)
    let lowestTrump = null;
    let firstAttackerIndex = null;
    
    room.players.forEach((player, index) => {
        player.hand.forEach(card => {
            if (card.isTrump && (!lowestTrump || card.value < lowestTrump.value)) {
                lowestTrump = card;
                firstAttackerIndex = index;
            }
        });
    });
    
    // If no one has trump, random start
    if (firstAttackerIndex === null) {
        firstAttackerIndex = Math.floor(Math.random() * 2);
    }
    
    room.currentAttacker = room.players[firstAttackerIndex].id;
    room.currentDefender = room.players[1 - firstAttackerIndex].id;
    
    return true;
}

// Get safe game state (hide opponent's cards)
function getSafeGameState(room, playerId) {
    const safeRoom = {
        code: room.code,
        gameState: room.gameState,
        gamePhase: room.gamePhase,
        battlefield: room.battlefield,
        deckCount: room.deck.length,
        trumpCard: room.trumpCard,
        trumpSuit: room.trumpSuit,
        currentAttacker: room.currentAttacker,
        currentDefender: room.currentDefender,
        players: room.players.map(p => ({
            id: p.id,
            name: p.name,
            ready: p.ready,
            cardCount: p.hand.length,
            hand: p.id === playerId ? p.hand : null,
            connected: p.connected
        }))
    };
    return safeRoom;
}

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log('New connection:', socket.id);
    
    // Create a new room
    socket.on('createRoom', (data) => {
        const { playerName } = data;
        const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
        
        const room = createRoom(roomCode, socket.id, playerName);
        socket.join(roomCode);
        
        socket.emit('roomCreated', {
            roomCode: roomCode,
            gameState: getSafeGameState(room, socket.id)
        });
        
        console.log(`Room ${roomCode} created by ${playerName}`);
    });
    
    // Join an existing room
    socket.on('joinRoom', (data) => {
        const { roomCode, playerName } = data;
        const room = gameRooms.get(roomCode);
        
        if (!room) {
            socket.emit('error', { message: 'Room not found' });
            return;
        }
        
        if (room.players.length >= 2) {
            socket.emit('error', { message: 'Room is full' });
            return;
        }
        
        // Add player to room
        room.players.push({
            id: socket.id,
            name: playerName,
            ready: false,
            hand: [],
            connected: true
        });
        
        playerRooms.set(socket.id, roomCode);
        socket.join(roomCode);
        
        // Notify all players in room
        io.to(roomCode).emit('playerJoined', {
            gameState: getSafeGameState(room, socket.id)
        });
        
        console.log(`${playerName} joined room ${roomCode}`);
    });
    
    // Player ready
    socket.on('playerReady', () => {
        const roomCode = playerRooms.get(socket.id);
        const room = gameRooms.get(roomCode);
        
        if (!room) return;
        
        const player = room.players.find(p => p.id === socket.id);
        if (player) {
            player.ready = true;
            
            // Check if all players are ready
            if (room.players.length === 2 && room.players.every(p => p.ready)) {
                if (startGame(roomCode)) {
                    // Send game state to each player with their own cards visible
                    room.players.forEach(p => {
                        io.to(p.id).emit('gameStarted', {
                            gameState: getSafeGameState(room, p.id)
                        });
                    });
                    
                    console.log(`Game started in room ${roomCode}`);
                }
            } else {
                io.to(roomCode).emit('playerReadyUpdate', {
                    playerId: socket.id,
                    ready: true
                });
            }
        }
    });
    
    // Play a card (attack or defend)
    socket.on('playCard', (data) => {
        const { cardIndex } = data;
        const roomCode = playerRooms.get(socket.id);
        const room = gameRooms.get(roomCode);
        
        if (!room || room.gameState !== 'playing') return;
        
        const player = room.players.find(p => p.id === socket.id);
        if (!player || cardIndex >= player.hand.length) return;
        
        const card = player.hand[cardIndex];
        
        // Handle attack
        if (room.currentAttacker === socket.id && room.gamePhase === 'attacking') {
            // Check if this card can be played
            if (room.battlefield.length > 0) {
                const validRanks = new Set();
                room.battlefield.forEach(pair => {
                    validRanks.add(pair.attack.rank);
                    if (pair.defense) validRanks.add(pair.defense.rank);
                });
                
                if (!validRanks.has(card.rank)) {
                    socket.emit('error', { message: 'Invalid card for attack' });
                    return;
                }
            }
            
            // Play attack card
            room.battlefield.push({ attack: card, defense: null });
            player.hand.splice(cardIndex, 1);
            room.gamePhase = 'defending';
            
            // Notify all players
            room.players.forEach(p => {
                io.to(p.id).emit('cardPlayed', {
                    gameState: getSafeGameState(room, p.id),
                    action: 'attack',
                    playerId: socket.id
                });
            });
        }
        
        // Handle defense
        else if (room.currentDefender === socket.id && room.gamePhase === 'defending') {
            // Find undefended attack
            const undefended = room.battlefield.find(pair => !pair.defense);
            if (!undefended) return;
            
            // Check if card can defend
            if (canDefend(card, undefended.attack)) {
                undefended.defense = card;
                player.hand.splice(cardIndex, 1);
                
                // Check if all attacks are defended
                if (room.battlefield.every(pair => pair.defense)) {
                    room.gamePhase = 'attacking';
                }
                
                // Notify all players
                room.players.forEach(p => {
                    io.to(p.id).emit('cardPlayed', {
                        gameState: getSafeGameState(room, p.id),
                        action: 'defend',
                        playerId: socket.id
                    });
                });
            } else {
                socket.emit('error', { message: 'This card cannot defend' });
            }
        }
        
        checkGameEnd(room);
    });
    
    // Take cards
    socket.on('takeCards', () => {
        const roomCode = playerRooms.get(socket.id);
        const room = gameRooms.get(roomCode);
        
        if (!room || room.gameState !== 'playing') return;
        if (room.currentDefender !== socket.id) return;
        
        const defender = room.players.find(p => p.id === socket.id);
        const attacker = room.players.find(p => p.id === room.currentAttacker);
        
        // Defender takes all cards from battlefield
        room.battlefield.forEach(pair => {
            defender.hand.push(pair.attack);
            if (pair.defense) defender.hand.push(pair.defense);
        });
        room.battlefield = [];
        
        // Draw cards
        while (attacker.hand.length < 6 && room.deck.length > 0) {
            attacker.hand.push(room.deck.pop());
        }
        while (defender.hand.length < 6 && room.deck.length > 0) {
            defender.hand.push(room.deck.pop());
        }
        
        // Attacker continues
        room.gamePhase = 'attacking';
        
        // Notify all players
        room.players.forEach(p => {
            io.to(p.id).emit('cardsTaken', {
                gameState: getSafeGameState(room, p.id),
                playerId: socket.id
            });
        });
        
        checkGameEnd(room);
    });
    
    // Pass (successful defense)
    socket.on('pass', () => {
        const roomCode = playerRooms.get(socket.id);
        const room = gameRooms.get(roomCode);
        
        if (!room || room.gameState !== 'playing') return;
        if (room.currentDefender !== socket.id) return;
        if (!room.battlefield.every(pair => pair.defense)) return;
        
        const defender = room.players.find(p => p.id === socket.id);
        const attacker = room.players.find(p => p.id === room.currentAttacker);
        
        // Clear battlefield
        room.battlefield = [];
        
        // Draw cards
        while (attacker.hand.length < 6 && room.deck.length > 0) {
            attacker.hand.push(room.deck.pop());
        }
        while (defender.hand.length < 6 && room.deck.length > 0) {
            defender.hand.push(room.deck.pop());
        }
        
        // Switch roles
        const temp = room.currentAttacker;
        room.currentAttacker = room.currentDefender;
        room.currentDefender = temp;
        room.gamePhase = 'attacking';
        
        // Notify all players
        room.players.forEach(p => {
            io.to(p.id).emit('passed', {
                gameState: getSafeGameState(room, p.id)
            });
        });
        
        checkGameEnd(room);
    });
    
    // End attack
    socket.on('endAttack', () => {
        const roomCode = playerRooms.get(socket.id);
        const room = gameRooms.get(roomCode);
        
        if (!room || room.gameState !== 'playing') return;
        if (room.currentAttacker !== socket.id) return;
        if (!room.battlefield.every(pair => pair.defense)) return;
        
        const attacker = room.players.find(p => p.id === socket.id);
        const defender = room.players.find(p => p.id === room.currentDefender);
        
        // Clear battlefield
        room.battlefield = [];
        
        // Draw cards
        while (attacker.hand.length < 6 && room.deck.length > 0) {
            attacker.hand.push(room.deck.pop());
        }
        while (defender.hand.length < 6 && room.deck.length > 0) {
            defender.hand.push(room.deck.pop());
        }
        
        // Switch roles
        const temp = room.currentAttacker;
        room.currentAttacker = room.currentDefender;
        room.currentDefender = temp;
        room.gamePhase = 'attacking';
        
        // Notify all players
        room.players.forEach(p => {
            io.to(p.id).emit('attackEnded', {
                gameState: getSafeGameState(room, p.id)
            });
        });
        
        checkGameEnd(room);
    });
    
    // Send message
    socket.on('sendMessage', (data) => {
        const roomCode = playerRooms.get(socket.id);
        const room = gameRooms.get(roomCode);
        
        if (!room) return;
        
        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;
        
        io.to(roomCode).emit('newMessage', {
            playerName: player.name,
            message: data.message,
            timestamp: new Date().toISOString()
        });
    });
    
    // Handle disconnection
    socket.on('disconnect', () => {
        const roomCode = playerRooms.get(socket.id);
        const room = gameRooms.get(roomCode);
        
        if (room) {
            const player = room.players.find(p => p.id === socket.id);
            if (player) {
                player.connected = false;
                
                // Notify other players
                io.to(roomCode).emit('playerDisconnected', {
                    playerId: socket.id,
                    playerName: player.name
                });
                
                // Clean up room if empty
                setTimeout(() => {
                    const room = gameRooms.get(roomCode);
                    if (room && room.players.every(p => !p.connected)) {
                        gameRooms.delete(roomCode);
                        console.log(`Room ${roomCode} deleted (all players disconnected)`);
                    }
                }, 30000); // Wait 30 seconds before cleaning up
            }
        }
        
        playerRooms.delete(socket.id);
        console.log('Player disconnected:', socket.id);
    });
    
    // Reconnect to room
    socket.on('reconnect', (data) => {
        const { roomCode, playerId } = data;
        const room = gameRooms.get(roomCode);
        
        if (room) {
            const player = room.players.find(p => p.id === playerId);
            if (player) {
                // Update player's socket ID
                const oldId = player.id;
                player.id = socket.id;
                player.connected = true;
                
                playerRooms.delete(oldId);
                playerRooms.set(socket.id, roomCode);
                socket.join(roomCode);
                
                // Send current game state
                socket.emit('reconnected', {
                    gameState: getSafeGameState(room, socket.id)
                });
                
                // Notify others
                socket.to(roomCode).emit('playerReconnected', {
                    playerName: player.name
                });
                
                console.log(`Player ${player.name} reconnected to room ${roomCode}`);
            }
        }
    });
});

// Helper function to check if a card can defend
function canDefend(defenseCard, attackCard) {
    // Trump can beat non-trump
    if (defenseCard.isTrump && !attackCard.isTrump) {
        return true;
    }
    // Same suit, higher value
    if (defenseCard.suit === attackCard.suit && defenseCard.value > attackCard.value) {
        return true;
    }
    return false;
}

// Check for game end
function checkGameEnd(room) {
    if (room.deck.length === 0) {
        const playersWithCards = room.players.filter(p => p.hand.length > 0);
        
        if (playersWithCards.length === 0) {
            room.gameState = 'finished';
            io.to(room.code).emit('gameDraw');
        } else if (playersWithCards.length === 1) {
            room.gameState = 'finished';
            const loser = playersWithCards[0];
            const winner = room.players.find(p => p.id !== loser.id);
            
            io.to(room.code).emit('gameOver', {
                winner: winner.id,
                winnerName: winner.name,
                loser: loser.id,
                loserName: loser.name
            });
        }
    }
}

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Durak server running on port ${PORT}`);
    console.log(`Open http://localhost:${PORT} in your browser`);
});