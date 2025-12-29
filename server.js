// server.js - Durak Multiplayer Server (2-6 Players) - FIXED
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
const playerRooms = new Map();

// Game constants
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 6;
const INITIAL_HAND_SIZE = 6;
const MAX_BATTLEFIELD_SIZE = 6;

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

// Clean up empty or broken rooms
function cleanupRoom(roomCode) {
    const room = gameRooms.get(roomCode);
    if (!room) return;
    
    // Check if room should be deleted
    const shouldDelete = room.players.length === 0 || 
                         room.players.every(p => !p.connected);
    
    if (shouldDelete) {
        // Clear any timers
        if (room.throwInTimer) {
            clearTimeout(room.throwInTimer);
        }
        if (room.turnTimer) {
            clearTimeout(room.turnTimer);
        }
        
        // Remove all player mappings
        room.players.forEach(p => {
            playerRooms.delete(p.id);
        });
        
        // Delete the room
        gameRooms.delete(roomCode);
        console.log(`Room ${roomCode} cleaned up`);
        return true;
    }
    return false;
}

// Create a new game room
function createRoom(roomCode, creatorId, creatorName, maxPlayers = 4) {
    // Clean up any existing room with same code first
    if (gameRooms.has(roomCode)) {
        cleanupRoom(roomCode);
    }
    
    const room = {
        code: roomCode,
        maxPlayers: Math.min(Math.max(maxPlayers, MIN_PLAYERS), MAX_PLAYERS),
        players: [{
            id: creatorId,
            name: creatorName,
            ready: false,
            hand: [],
            connected: true,
            position: 0,
            isActive: true,
            hasWon: false
        }],
        gameState: 'waiting',
        deck: [],
        battlefield: [],
        trumpCard: null,
        trumpSuit: '',
        initialAttackerId: null,
        currentDefenderId: null,
        additionalAttackers: [],
        gamePhase: 'waiting',
        throwInTimer: null,
        throwInDeadline: null,
        validThrowInRanks: new Set(),
        throwInCards: [],
        maxThrowInTotal: 6,
        turnTimer: null,
        lastAction: Date.now(),
        winners: [],
        playerOrder: [],
        createdAt: Date.now()
    };
    
    gameRooms.set(roomCode, room);
    playerRooms.set(creatorId, roomCode);
    return room;
}

// Get next active player in clockwise order
function getNextActivePlayer(room, afterPlayerId) {
    const afterPlayer = room.players.find(p => p.id === afterPlayerId);
    if (!afterPlayer) return null;
    
    let nextPosition = (afterPlayer.position + 1) % room.players.length;
    let attempts = 0;
    
    while (attempts < room.players.length) {
        const nextPlayer = room.players.find(p => p.position === nextPosition);
        if (nextPlayer && nextPlayer.isActive && !nextPlayer.hasWon) {
            return nextPlayer;
        }
        nextPosition = (nextPosition + 1) % room.players.length;
        attempts++;
    }
    
    return null;
}

// Get all active players who can attack (everyone except defender)
function getAttackers(room) {
    if (!room.currentDefenderId) return [];
    return room.players.filter(p => 
        p.isActive && 
        !p.hasWon && 
        p.id !== room.currentDefenderId &&
        p.hand.length > 0
    );
}

// Start a game in a room
function startGame(roomCode) {
    const room = gameRooms.get(roomCode);
    if (!room || room.players.length < MIN_PLAYERS) return false;
    
    // Initialize game
    room.deck = createDeck();
    room.battlefield = [];
    room.throwInCards = [];
    room.gameState = 'playing';
    room.gamePhase = 'attacking';
    room.winners = [];
    
    // Set player positions (clockwise order)
    room.players.forEach((player, index) => {
        player.position = index;
        player.hand = [];
        player.isActive = true;
        player.hasWon = false;
    });
    
    // Deal initial cards
    for (let i = 0; i < INITIAL_HAND_SIZE; i++) {
        room.players.forEach(player => {
            if (room.deck.length > 0) {
                player.hand.push(room.deck.pop());
            }
        });
    }
    
    // Set trump card
    room.trumpCard = room.deck[0];
    room.trumpSuit = room.trumpCard.suit;
    
    // Mark trump cards
    [...room.deck, ...room.players.flatMap(p => p.hand)].forEach(card => {
        card.isTrump = card.suit === room.trumpSuit;
    });
    
    // Determine first attacker (player with lowest trump)
    let lowestTrump = null;
    let firstAttacker = null;
    
    room.players.forEach(player => {
        player.hand.forEach(card => {
            if (card.isTrump && (!lowestTrump || card.value < lowestTrump.value)) {
                lowestTrump = card;
                firstAttacker = player;
            }
        });
    });
    
    // If no one has trump, random start
    if (!firstAttacker) {
        firstAttacker = room.players[Math.floor(Math.random() * room.players.length)];
    }
    
    // Set initial attacker and defender
    room.initialAttackerId = firstAttacker.id;
    room.currentDefenderId = getNextActivePlayer(room, firstAttacker.id).id;
    room.additionalAttackers = getAttackers(room).filter(p => p.id !== room.initialAttackerId).map(p => p.id);
    
    updatePlayerOrder(room);
    
    return true;
}

// Update the order of active players
function updatePlayerOrder(room) {
    room.playerOrder = room.players
        .filter(p => p.isActive && !p.hasWon)
        .sort((a, b) => a.position - b.position)
        .map(p => p.id);
}

// Get safe game state (hide opponent's cards)
function getSafeGameState(room, playerId) {
    const player = room.players.find(p => p.id === playerId);
    const safeRoom = {
        code: room.code,
        maxPlayers: room.maxPlayers,
        gameState: room.gameState,
        gamePhase: room.gamePhase,
        battlefield: room.battlefield,
        throwInCards: room.throwInCards,
        deckCount: room.deck.length,
        trumpCard: room.trumpCard,
        trumpSuit: room.trumpSuit,
        initialAttackerId: room.initialAttackerId,
        currentDefenderId: room.currentDefenderId,
        additionalAttackers: room.additionalAttackers,
        throwInDeadline: room.throwInDeadline,
        validThrowInRanks: Array.from(room.validThrowInRanks),
        winners: room.winners,
        playerOrder: room.playerOrder,
        players: room.players.map(p => ({
            id: p.id,
            name: p.name,
            ready: p.ready,
            position: p.position,
            cardCount: p.hand.length,
            hand: p.id === playerId ? p.hand : null,
            connected: p.connected,
            isActive: p.isActive,
            hasWon: p.hasWon,
            isInitialAttacker: p.id === room.initialAttackerId,
            isDefender: p.id === room.currentDefenderId,
            canAttack: room.additionalAttackers.includes(p.id) || p.id === room.initialAttackerId
        }))
    };
    return safeRoom;
}

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log('New connection:', socket.id);
    
    // Create a new room
    socket.on('createRoom', (data) => {
        const { playerName, maxPlayers } = data;
        
        // Check if player is already in a room
        const existingRoomCode = playerRooms.get(socket.id);
        if (existingRoomCode) {
            const existingRoom = gameRooms.get(existingRoomCode);
            if (existingRoom) {
                // Leave existing room first
                handlePlayerLeave(socket.id, existingRoomCode);
            }
        }
        
        const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
        
        const room = createRoom(roomCode, socket.id, playerName, maxPlayers || 4);
        socket.join(roomCode);
        
        socket.emit('roomCreated', {
            roomCode: roomCode,
            gameState: getSafeGameState(room, socket.id)
        });
        
        console.log(`Room ${roomCode} created by ${playerName} (max ${room.maxPlayers} players)`);
    });
    
    // Join an existing room
    socket.on('joinRoom', (data) => {
        const { roomCode, playerName } = data;
        const room = gameRooms.get(roomCode);
        
        if (!room) {
            socket.emit('error', { message: 'Room not found' });
            return;
        }
        
        // Check if player is already in this room (might be reconnecting)
        const existingPlayer = room.players.find(p => p.id === socket.id);
        if (existingPlayer) {
            // Reconnection - just update connection status
            existingPlayer.connected = true;
            socket.join(roomCode);
            
            socket.emit('roomJoined', {
                gameState: getSafeGameState(room, socket.id)
            });
            
            io.to(roomCode).emit('playerReconnected', {
                playerId: socket.id,
                playerName: existingPlayer.name
            });
            return;
        }
        
        // Check if player is in another room
        const existingRoomCode = playerRooms.get(socket.id);
        if (existingRoomCode && existingRoomCode !== roomCode) {
            handlePlayerLeave(socket.id, existingRoomCode);
        }
        
        if (room.players.length >= room.maxPlayers) {
            socket.emit('error', { message: 'Room is full' });
            return;
        }
        
        if (room.gameState !== 'waiting') {
            socket.emit('error', { message: 'Game already in progress' });
            return;
        }
        
        // Add player to room
        room.players.push({
            id: socket.id,
            name: playerName,
            ready: false,
            hand: [],
            connected: true,
            position: room.players.length,
            isActive: true,
            hasWon: false
        });
        
        playerRooms.set(socket.id, roomCode);
        socket.join(roomCode);
        
        // Notify all players in room
        io.to(roomCode).emit('playerJoined', {
            gameState: getSafeGameState(room, socket.id)
        });
        
        console.log(`${playerName} joined room ${roomCode} (${room.players.length}/${room.maxPlayers})`);
    });
    
    // Handle player leaving
    function handlePlayerLeave(playerId, roomCode) {
        const room = gameRooms.get(roomCode);
        if (!room) return;
        
        const playerIndex = room.players.findIndex(p => p.id === playerId);
        if (playerIndex === -1) return;
        
        const player = room.players[playerIndex];
        
        // If game hasn't started, remove player completely
        if (room.gameState === 'waiting') {
            room.players.splice(playerIndex, 1);
            playerRooms.delete(playerId);
            
            // Update positions
            room.players.forEach((p, i) => {
                p.position = i;
            });
            
            // Notify other players
            io.to(roomCode).emit('playerLeft', {
                playerId: playerId,
                playerName: player.name,
                gameState: getSafeGameState(room, playerId)
            });
            
            // Clean up empty room
            if (room.players.length === 0) {
                cleanupRoom(roomCode);
            }
        } else {
            // Game in progress - just mark as disconnected
            player.connected = false;
            
            io.to(roomCode).emit('playerDisconnected', {
                playerId: playerId,
                playerName: player.name
            });
        }
    }
    
    // Player ready
    socket.on('playerReady', () => {
        const roomCode = playerRooms.get(socket.id);
        const room = gameRooms.get(roomCode);
        
        if (!room) return;
        
        const player = room.players.find(p => p.id === socket.id);
        if (player) {
            player.ready = true;
            
            // Check if all players are ready (minimum 2 players)
            if (room.players.length >= MIN_PLAYERS && room.players.every(p => p.ready)) {
                if (startGame(roomCode)) {
                    // Send game state to each player with their own cards visible
                    room.players.forEach(p => {
                        io.to(p.id).emit('gameStarted', {
                            gameState: getSafeGameState(room, p.id)
                        });
                    });
                    
                    console.log(`Game started in room ${roomCode} with ${room.players.length} players`);
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
        
        // Handle attack (initial attacker or additional attackers)
        if ((room.initialAttackerId === socket.id || room.additionalAttackers.includes(socket.id)) 
            && room.gamePhase === 'attacking') {
            
            // Check maximum attack limit
            const defender = room.players.find(p => p.id === room.currentDefenderId);
            const maxAttacks = Math.min(MAX_BATTLEFIELD_SIZE, defender.hand.length);
            
            if (room.battlefield.length >= maxAttacks) {
                socket.emit('error', { message: `Cannot attack with more than ${maxAttacks} cards` });
                return;
            }
            
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
            room.battlefield.push({ 
                attack: card, 
                defense: null,
                attackerId: socket.id 
            });
            player.hand.splice(cardIndex, 1);
            room.gamePhase = 'defending';
            
            // Notify all players
            room.players.forEach(p => {
                io.to(p.id).emit('cardPlayed', {
                    gameState: getSafeGameState(room, p.id),
                    action: 'attack',
                    playerId: socket.id,
                    playerName: player.name
                });
            });
            
            checkForWinner(room, player);
        }
        
        // Handle defense
        else if (room.currentDefenderId === socket.id && room.gamePhase === 'defending') {
            // Find undefended attack
            const undefended = room.battlefield.find(pair => !pair.defense);
            if (!undefended) return;
            
            // Check if card can defend
            if (canDefend(card, undefended.attack)) {
                undefended.defense = card;
                player.hand.splice(cardIndex, 1);
                
                // Check if all attacks are defended
                if (room.battlefield.every(pair => pair.defense)) {
                    // Attackers can now continue attacking or end turn
                    room.gamePhase = 'attacking';
                }
                
                // Notify all players
                room.players.forEach(p => {
                    io.to(p.id).emit('cardPlayed', {
                        gameState: getSafeGameState(room, p.id),
                        action: 'defend',
                        playerId: socket.id,
                        playerName: player.name,
                        allDefended: room.battlefield.every(pair => pair.defense)
                    });
                });
                
                checkForWinner(room, player);
            } else {
                socket.emit('error', { message: 'This card cannot defend' });
            }
        }
        
        // Handle throw-in phase
        else if ((room.initialAttackerId === socket.id || room.additionalAttackers.includes(socket.id))
                 && room.gamePhase === 'throwIn') {
            // Check if card rank is valid for throw-in
            if (!room.validThrowInRanks.has(card.rank)) {
                socket.emit('error', { message: 'You can only throw in cards with ranks that were already played' });
                return;
            }
            
            // Check if we've reached the limit
            const totalCards = room.battlefield.length + room.throwInCards.length;
            
            if (totalCards >= room.maxThrowInTotal) {
                socket.emit('error', { message: `Cannot add more cards - maximum ${room.maxThrowInTotal} cards total` });
                return;
            }
            
            // Add card to throw-in pile
            room.throwInCards.push({
                card: card,
                playerId: socket.id
            });
            player.hand.splice(cardIndex, 1);
            
            // Notify all players
            room.players.forEach(p => {
                io.to(p.id).emit('throwInCard', {
                    gameState: getSafeGameState(room, p.id),
                    card: card,
                    playerName: player.name,
                    remainingCapacity: room.maxThrowInTotal - (room.battlefield.length + room.throwInCards.length)
                });
            });
            
            checkForWinner(room, player);
        }
    });
    
    // Deflect attack
    socket.on('deflectAttack', (data) => {
        const { cardIndex } = data;
        const roomCode = playerRooms.get(socket.id);
        const room = gameRooms.get(roomCode);
        
        if (!room || room.gameState !== 'playing') return;
        if (room.currentDefenderId !== socket.id) return;
        if (room.gamePhase !== 'defending') return;
        
        // Can only deflect if no cards have been defended yet
        if (room.battlefield.some(pair => pair.defense)) {
            socket.emit('error', { message: 'Cannot deflect after defending cards' });
            return;
        }
        
        const defender = room.players.find(p => p.id === socket.id);
        const nextDefender = getNextActivePlayer(room, socket.id);
        
        if (!nextDefender) {
            socket.emit('error', { message: 'Cannot deflect - no next player to defend' });
            return;
        }
        
        if (cardIndex >= defender.hand.length) return;
        const deflectCard = defender.hand[cardIndex];
        
        // Check if deflect card has same rank as any undefended attack
        let canDeflect = false;
        for (let pair of room.battlefield) {
            if (!pair.defense && pair.attack.rank === deflectCard.rank) {
                canDeflect = true;
                break;
            }
        }
        
        if (!canDeflect) {
            socket.emit('error', { message: 'You can only deflect with cards of the same rank' });
            return;
        }
        
        // Check if total attacks don't exceed next defender's hand size
        const totalAttacks = room.battlefield.length + 1;
        if (totalAttacks > Math.min(MAX_BATTLEFIELD_SIZE, nextDefender.hand.length)) {
            socket.emit('error', { message: 'Cannot deflect - would exceed card limit for next defender' });
            return;
        }
        
        // Add deflect card to battlefield as new attack
        room.battlefield.push({ 
            attack: deflectCard, 
            defense: null,
            attackerId: socket.id 
        });
        defender.hand.splice(cardIndex, 1);
        
        // Update defender to next player
        room.currentDefenderId = nextDefender.id;
        
        // Update who can attack (everyone except new defender)
        room.additionalAttackers = getAttackers(room).filter(p => p.id !== room.initialAttackerId).map(p => p.id);
        
        // Stay in defending phase
        room.gamePhase = 'defending';
        
        // Notify all players
        room.players.forEach(p => {
            io.to(p.id).emit('attackDeflected', {
                gameState: getSafeGameState(room, p.id),
                deflectedBy: defender.name,
                newDefender: nextDefender.name,
                card: deflectCard
            });
        });
        
        checkForWinner(room, defender);
    });
    
    // Take cards
    socket.on('takeCards', () => {
        const roomCode = playerRooms.get(socket.id);
        const room = gameRooms.get(roomCode);
        
        if (!room || room.gameState !== 'playing') return;
        if (room.currentDefenderId !== socket.id) return;
        
        const defender = room.players.find(p => p.id === socket.id);
        
        // Calculate how many cards the defender will take initially
        const initialDefenderCards = defender.hand.length;
        const battlefieldCards = room.battlefield.length;
        
        // Maximum total cards that can be given is min(6, initial defender hand size)
        room.maxThrowInTotal = Math.min(MAX_BATTLEFIELD_SIZE, initialDefenderCards);
        
        // Collect valid ranks for throw-in
        room.validThrowInRanks.clear();
        room.battlefield.forEach(pair => {
            room.validThrowInRanks.add(pair.attack.rank);
            if (pair.defense) room.validThrowInRanks.add(pair.defense.rank);
        });
        
        // Enter throw-in phase
        room.gamePhase = 'throwIn';
        room.throwInCards = [];
        room.throwInDeadline = Date.now() + 3000;
        
        // Calculate remaining throw-in capacity
        const remainingCapacity = room.maxThrowInTotal - battlefieldCards;
        
        // Notify all players about throw-in phase
        room.players.forEach(p => {
            io.to(p.id).emit('throwInPhase', {
                gameState: getSafeGameState(room, p.id),
                validRanks: Array.from(room.validThrowInRanks),
                maxThrowIn: remainingCapacity,
                currentCards: battlefieldCards
            });
        });
        
        // Set timer to complete the take after 3 seconds
        if (room.throwInTimer) {
            clearTimeout(room.throwInTimer);
        }
        
        room.throwInTimer = setTimeout(() => {
            completeTakeCards(room);
        }, 3000);
    });
    
    // Complete throw-in phase early
    socket.on('finishThrowIn', () => {
        const roomCode = playerRooms.get(socket.id);
        const room = gameRooms.get(roomCode);
        
        if (!room || room.gameState !== 'playing') return;
        if (room.initialAttackerId !== socket.id || room.gamePhase !== 'throwIn') return;
        
        // Clear timer and complete take
        if (room.throwInTimer) {
            clearTimeout(room.throwInTimer);
            room.throwInTimer = null;
        }
        
        completeTakeCards(room);
    });
    
    // End attack
    socket.on('endAttack', () => {
        const roomCode = playerRooms.get(socket.id);
        const room = gameRooms.get(roomCode);
        
        if (!room || room.gameState !== 'playing') return;
        if (room.initialAttackerId !== socket.id) return;
        
        // Can end attack if:
        // 1. All attacks are defended (defender succeeded)
        // 2. Attacker chooses to end during attacking phase
        if (room.gamePhase === 'attacking' || 
            (room.battlefield.length > 0 && room.battlefield.every(pair => pair.defense))) {
            
            completeSuccessfulDefense(room);
        }
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
            handlePlayerLeave(socket.id, roomCode);
        }
        
        playerRooms.delete(socket.id);
        console.log('Player disconnected:', socket.id);
    });
});

// Helper function to complete taking cards after throw-in
function completeTakeCards(room) {
    const defender = room.players.find(p => p.id === room.currentDefenderId);
    
    // Defender takes all cards from battlefield and throw-in pile
    room.battlefield.forEach(pair => {
        defender.hand.push(pair.attack);
        if (pair.defense) defender.hand.push(pair.defense);
    });
    
    // Add throw-in cards
    room.throwInCards.forEach(item => {
        defender.hand.push(item.card);
    });
    
    const totalCardsTaken = room.battlefield.reduce((sum, pair) => 
        sum + 1 + (pair.defense ? 1 : 0), 0) + room.throwInCards.length;
    
    room.battlefield = [];
    room.throwInCards = [];
    room.validThrowInRanks.clear();
    
    // Draw cards for all players who attacked
    const initialAttacker = room.players.find(p => p.id === room.initialAttackerId);
    if (initialAttacker) {
        drawCardsForPlayer(room, initialAttacker);
    }
    
    // Draw for other attackers
    room.players.forEach(player => {
        if (player.id !== room.initialAttackerId && player.id !== room.currentDefenderId && player.isActive && !player.hasWon) {
            drawCardsForPlayer(room, player);
        }
    });
    
    // Initial attacker continues
    room.gamePhase = 'attacking';
    room.throwInDeadline = null;
    
    // Notify all players
    room.players.forEach(p => {
        io.to(p.id).emit('cardsTaken', {
            gameState: getSafeGameState(room, p.id),
            totalCards: totalCardsTaken
        });
    });
    
    checkGameEnd(room);
}

// Helper function for successful defense
function completeSuccessfulDefense(room) {
    // Clear battlefield
    room.battlefield = [];
    room.throwInCards = [];
    
    // Draw cards for all active players in clockwise order
    const defender = room.players.find(p => p.id === room.currentDefenderId);
    const initialAttacker = room.players.find(p => p.id === room.initialAttackerId);
    
    // Draw for initial attacker first
    if (initialAttacker) {
        drawCardsForPlayer(room, initialAttacker);
    }
    
    // Draw for other players in clockwise order
    room.players.forEach(player => {
        if (player.id !== room.initialAttackerId && player.isActive && !player.hasWon) {
            drawCardsForPlayer(room, player);
        }
    });
    
    // Defender becomes new attacker, next player defends
    if (defender) {
        room.initialAttackerId = defender.id;
        const nextDefender = getNextActivePlayer(room, defender.id);
        
        if (nextDefender) {
            room.currentDefenderId = nextDefender.id;
            room.additionalAttackers = getAttackers(room).filter(p => p.id !== room.initialAttackerId).map(p => p.id);
        }
    }
    
    room.gamePhase = 'attacking';
    
    // Notify all players
    room.players.forEach(p => {
        io.to(p.id).emit('attackEnded', {
            gameState: getSafeGameState(room, p.id)
        });
    });
    
    checkGameEnd(room);
}

// Draw cards for a player
function drawCardsForPlayer(room, player) {
    while (player.hand.length < INITIAL_HAND_SIZE && room.deck.length > 0) {
        const card = room.deck.pop();
        card.isTrump = card.suit === room.trumpSuit;
        player.hand.push(card);
    }
}

// Check if player has won (no cards left)
function checkForWinner(room, player) {
    if (player.hand.length === 0 && room.deck.length === 0) {
        player.hasWon = true;
        player.isActive = false;
        room.winners.push({
            id: player.id,
            name: player.name,
            position: room.winners.length + 1
        });
        
        // Notify all players
        room.players.forEach(p => {
            io.to(p.id).emit('playerWon', {
                playerId: player.id,
                playerName: player.name,
                position: room.winners.length
            });
        });
        
        // If this was the defender or attacker, need to reassign
        if (player.id === room.currentDefenderId) {
            const nextDefender = getNextActivePlayer(room, player.id);
            if (nextDefender) {
                room.currentDefenderId = nextDefender.id;
            }
        } else if (player.id === room.initialAttackerId) {
            const nextAttacker = getNextActivePlayer(room, player.id);
            if (nextAttacker) {
                room.initialAttackerId = nextAttacker.id;
            }
        }
        
        updatePlayerOrder(room);
    }
}

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
    const activePlayers = room.players.filter(p => p.isActive && !p.hasWon);
    
    if (room.deck.length === 0) {
        // Check if only one player has cards left
        const playersWithCards = activePlayers.filter(p => p.hand.length > 0);
        
        if (playersWithCards.length <= 1) {
            room.gameState = 'finished';
            
            // Last player with cards is the Durak (loser)
            if (playersWithCards.length === 1) {
                const durak = playersWithCards[0];
                
                io.to(room.code).emit('gameOver', {
                    durak: {
                        id: durak.id,
                        name: durak.name
                    },
                    winners: room.winners
                });
            } else {
                // Everyone ran out of cards at the same time (very rare)
                io.to(room.code).emit('gameDraw', {
                    winners: room.winners
                });
            }
            
            // Clean up room after 10 seconds
            setTimeout(() => {
                cleanupRoom(room.code);
            }, 10000);
        }
    }
}

// Periodic cleanup of old/broken rooms
setInterval(() => {
    const now = Date.now();
    const maxAge = 30 * 60 * 1000; // 30 minutes
    
    gameRooms.forEach((room, code) => {
        // Clean up old waiting rooms
        if (room.gameState === 'waiting' && (now - room.createdAt) > maxAge) {
            console.log(`Cleaning up old waiting room ${code}`);
            cleanupRoom(code);
        }
        // Clean up rooms where all players disconnected
        else if (room.players.every(p => !p.connected)) {
            console.log(`Cleaning up abandoned room ${code}`);
            cleanupRoom(code);
        }
    });
}, 60000); // Run every minute

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Durak server running on port ${PORT}`);
    console.log(`Open http://localhost:${PORT} in your browser`);
});
