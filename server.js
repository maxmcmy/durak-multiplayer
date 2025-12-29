// server.js - Durak Multiplayer Server with Game Modes (Classic & Ultimate)
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
const VOTE_TIMEOUT = 20000; // 20 seconds to vote

// Card representations - Updated for both modes
const suits = ['♠', '♥', '♦', '♣'];

// Classic mode: 36 cards (6-Ace)
const classicRanks = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const classicRankValues = {'6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14};

// Ultimate mode: 52 cards (2-Ace)
const ultimateRanks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const ultimateRankValues = {'2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14};

// Create a new deck based on game mode
function createDeck(gameMode = 'classic') {
    const deck = [];
    const ranks = gameMode === 'ultimate' ? ultimateRanks : classicRanks;
    const rankValues = gameMode === 'ultimate' ? ultimateRankValues : classicRankValues;
    
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
        if (room.voteTimer) {
            clearTimeout(room.voteTimer);
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

// Create a new game room - Updated to include game mode
function createRoom(roomCode, creatorId, creatorName, maxPlayers = 4, gameMode = 'classic') {
    // Clean up any existing room with same code first
    if (gameRooms.has(roomCode)) {
        cleanupRoom(roomCode);
    }
    
    const room = {
        code: roomCode,
        maxPlayers: Math.min(Math.max(maxPlayers, MIN_PLAYERS), MAX_PLAYERS),
        gameMode: gameMode, // 'classic' or 'ultimate'
        players: [{
            id: creatorId,
            name: creatorName,
            ready: false,
            hand: [],
            connected: true,
            position: 0,
            isActive: true,
            hasWon: false,
            isSpectator: false,
            votedPlayAgain: false
        }],
        gameState: 'waiting', // waiting, playing, voting, finished
        deck: [],
        battlefield: [],
        trumpCard: null,
        trumpSuit: '',
        initialAttackerId: null,
        currentDefenderId: null,
        additionalAttackers: [],
        gamePhase: 'waiting', // waiting, attacking, defending, throwIn
        throwInTimer: null,
        throwInDeadline: null,
        validThrowInRanks: new Set(),
        throwInCards: [],
        maxThrowInTotal: 6,
        turnTimer: null,
        lastAction: Date.now(),
        winners: [],
        playerOrder: [],
        createdAt: Date.now(),
        roundNumber: 1,
        // Voting system
        playAgainVotes: new Map(),
        voteTimer: null,
        voteDeadline: null
    };
    
    gameRooms.set(roomCode, room);
    playerRooms.set(creatorId, roomCode);
    
    console.log(`Room ${roomCode} created in ${gameMode} mode with max ${maxPlayers} players`);
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
        if (nextPlayer && nextPlayer.isActive && !nextPlayer.hasWon && !nextPlayer.isSpectator) {
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
        !p.isSpectator &&
        p.id !== room.currentDefenderId &&
        p.hand.length > 0
    );
}

// Start a game in a room - Updated to use game mode
function startGame(roomCode) {
    const room = gameRooms.get(roomCode);
    if (!room) return false;
    
    // Count non-spectator players
    const activePlayers = room.players.filter(p => !p.isSpectator);
    if (activePlayers.length < MIN_PLAYERS) return false;
    
    // Initialize game with appropriate deck based on mode
    room.deck = createDeck(room.gameMode);
    room.battlefield = [];
    room.throwInCards = [];
    room.gameState = 'playing';
    room.gamePhase = 'attacking';
    room.winners = [];
    room.playAgainVotes.clear();
    
    // Set player positions (clockwise order) - only for non-spectators
    activePlayers.forEach((player, index) => {
        player.position = index;
        player.hand = [];
        player.isActive = true;
        player.hasWon = false;
        player.votedPlayAgain = false;
    });
    
    // Deal initial cards to active players only
    for (let i = 0; i < INITIAL_HAND_SIZE; i++) {
        activePlayers.forEach(player => {
            if (room.deck.length > 0) {
                player.hand.push(room.deck.pop());
            }
        });
    }
    
    // Set trump card
    room.trumpCard = room.deck[0];
    room.trumpSuit = room.trumpCard.suit;
    
    // Mark trump cards
    [...room.deck, ...activePlayers.flatMap(p => p.hand)].forEach(card => {
        card.isTrump = card.suit === room.trumpSuit;
    });
    
    // Determine first attacker (player with lowest trump)
    let lowestTrump = null;
    let firstAttacker = null;
    
    activePlayers.forEach(player => {
        player.hand.forEach(card => {
            if (card.isTrump && (!lowestTrump || card.value < lowestTrump.value)) {
                lowestTrump = card;
                firstAttacker = player;
            }
        });
    });
    
    // If no one has trump, random start
    if (!firstAttacker) {
        firstAttacker = activePlayers[Math.floor(Math.random() * activePlayers.length)];
    }
    
    // Set initial attacker and defender
    room.initialAttackerId = firstAttacker.id;
    room.currentDefenderId = getNextActivePlayer(room, firstAttacker.id).id;
    room.additionalAttackers = getAttackers(room).filter(p => p.id !== room.initialAttackerId).map(p => p.id);
    
    updatePlayerOrder(room);
    
    console.log(`Game started in room ${roomCode} (${room.gameMode} mode) with ${activePlayers.length} players`);
    return true;
}

// Reset room for new game with same players
function resetRoomForNewGame(room) {
    // Keep players who voted yes, remove those who didn't
    const stayingPlayers = room.players.filter(p => p.votedPlayAgain);
    
    // Reset player states
    stayingPlayers.forEach((player, index) => {
        player.ready = false;
        player.hand = [];
        player.position = index;
        player.isActive = true;
        player.hasWon = false;
        player.isSpectator = false;
        player.votedPlayAgain = false;
    });
    
    room.players = stayingPlayers;
    room.gameState = 'waiting';
    room.gamePhase = 'waiting';
    room.deck = [];
    room.battlefield = [];
    room.trumpCard = null;
    room.trumpSuit = '';
    room.initialAttackerId = null;
    room.currentDefenderId = null;
    room.additionalAttackers = [];
    room.throwInCards = [];
    room.winners = [];
    room.playerOrder = [];
    room.playAgainVotes.clear();
    room.roundNumber++;
    // Game mode persists between rounds
    
    // Clear timers
    if (room.throwInTimer) {
        clearTimeout(room.throwInTimer);
        room.throwInTimer = null;
    }
    if (room.voteTimer) {
        clearTimeout(room.voteTimer);
        room.voteTimer = null;
    }
}

// Update the order of active players
function updatePlayerOrder(room) {
    room.playerOrder = room.players
        .filter(p => p.isActive && !p.hasWon && !p.isSpectator)
        .sort((a, b) => a.position - b.position)
        .map(p => p.id);
}

// Get safe game state (hide opponent's cards) - Updated to include game mode
function getSafeGameState(room, playerId) {
    const player = room.players.find(p => p.id === playerId);
    const safeRoom = {
        code: room.code,
        maxPlayers: room.maxPlayers,
        gameMode: room.gameMode, // Include game mode
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
        roundNumber: room.roundNumber,
        voteDeadline: room.voteDeadline,
        playAgainVotes: Array.from(room.playAgainVotes.entries()),
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
            isSpectator: p.isSpectator,
            votedPlayAgain: p.votedPlayAgain,
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
    
    // Create a new room - Updated to handle game mode
    socket.on('createRoom', (data) => {
        const { playerName, maxPlayers, gameMode } = data;
        
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
        
        const room = createRoom(roomCode, socket.id, playerName, maxPlayers || 4, gameMode || 'classic');
        socket.join(roomCode);
        
        socket.emit('roomCreated', {
            roomCode: roomCode,
            gameState: getSafeGameState(room, socket.id)
        });
        
        console.log(`Room ${roomCode} created by ${playerName} (${room.gameMode} mode, max ${room.maxPlayers} players)`);
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
        
        // Check if room is full (but allow spectators)
        const activePlayers = room.players.filter(p => !p.isSpectator);
        const isSpectator = room.gameState === 'playing' || activePlayers.length >= room.maxPlayers;
        
        // Add player to room
        room.players.push({
            id: socket.id,
            name: playerName,
            ready: false,
            hand: [],
            connected: true,
            position: room.players.length,
            isActive: !isSpectator,
            hasWon: false,
            isSpectator: isSpectator,
            votedPlayAgain: false
        });
        
        playerRooms.set(socket.id, roomCode);
        socket.join(roomCode);
        
        // Notify all players in room
        io.to(roomCode).emit('playerJoined', {
            gameState: getSafeGameState(room, socket.id),
            playerName: playerName,
            isSpectator: isSpectator
        });
        
        const status = isSpectator ? 'spectating' : 'playing';
        console.log(`${playerName} joined room ${roomCode} (${room.gameMode} mode) as ${status}`);
    });
    
    // Handle player leaving
    function handlePlayerLeave(playerId, roomCode) {
        const room = gameRooms.get(roomCode);
        if (!room) return;
        
        const playerIndex = room.players.findIndex(p => p.id === playerId);
        if (playerIndex === -1) return;
        
        const player = room.players[playerIndex];
        
        // If game hasn't started or in voting, remove player completely
        if (room.gameState === 'waiting' || room.gameState === 'voting') {
            room.players.splice(playerIndex, 1);
            playerRooms.delete(playerId);
            
            // Update positions
            room.players.forEach((p, i) => {
                p.position = i;
            });
            
            // Clear vote if they had voted
            if (room.playAgainVotes.has(playerId)) {
                room.playAgainVotes.delete(playerId);
            }
            
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
        if (player && !player.isSpectator) {
            player.ready = true;
            
            // Check if all non-spectator players are ready (minimum 2 players)
            const activePlayers = room.players.filter(p => !p.isSpectator);
            if (activePlayers.length >= MIN_PLAYERS && activePlayers.every(p => p.ready)) {
                if (startGame(roomCode)) {
                    // Send game state to each player with their own cards visible
                    room.players.forEach(p => {
                        io.to(p.id).emit('gameStarted', {
                            gameState: getSafeGameState(room, p.id)
                        });
                    });
                    
                    console.log(`${room.gameMode} mode game started in room ${roomCode} with ${activePlayers.length} players`);
                }
            } else {
                io.to(roomCode).emit('playerReadyUpdate', {
                    playerId: socket.id,
                    ready: true
                });
            }
        }
    });
    
    // Vote to play again
    socket.on('votePlayAgain', (vote) => {
        const roomCode = playerRooms.get(socket.id);
        const room = gameRooms.get(roomCode);
        
        if (!room || room.gameState !== 'voting') return;
        
        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;
        
        player.votedPlayAgain = vote;
        room.playAgainVotes.set(socket.id, vote);
        
        // Notify others of the vote
        io.to(roomCode).emit('playerVoted', {
            playerId: socket.id,
            playerName: player.name,
            vote: vote,
            totalVotes: room.playAgainVotes.size,
            totalPlayers: room.players.filter(p => !p.isSpectator).length
        });
        
        // Check if all players have voted
        const eligiblePlayers = room.players.filter(p => !p.isSpectator);
        if (room.playAgainVotes.size === eligiblePlayers.length) {
            completeVoting(room);
        }
    });
    
    // Play a card (attack only - defend is now separate)
    socket.on('playCard', (data) => {
        const { cardIndex } = data;
        const roomCode = playerRooms.get(socket.id);
        const room = gameRooms.get(roomCode);
        
        if (!room || room.gameState !== 'playing') return;
        
        const player = room.players.find(p => p.id === socket.id);
        if (!player || player.isSpectator || cardIndex >= player.hand.length) return;
        
        const card = player.hand[cardIndex];
        
        // Handle attack (initial attacker or additional attackers can attack at ANY time)
        if ((room.initialAttackerId === socket.id || room.additionalAttackers.includes(socket.id)) 
            && (room.gamePhase === 'attacking' || room.gamePhase === 'defending')) {
            
            // Check maximum attack limit
            const defender = room.players.find(p => p.id === room.currentDefenderId);
            const undefendedAttacks = room.battlefield.filter(pair => !pair.defense).length;
            const maxAttacks = Math.min(MAX_BATTLEFIELD_SIZE, defender.hand.length);
            
            if (undefendedAttacks >= maxAttacks) {
                socket.emit('error', { message: `Cannot attack with more than ${maxAttacks} cards` });
                return;
            }
            
            // First attack can be any card, subsequent attacks must match ranks
            if (room.battlefield.length > 0) {
                const validRanks = new Set();
                room.battlefield.forEach(pair => {
                    validRanks.add(pair.attack.rank);
                    if (pair.defense) validRanks.add(pair.defense.rank);
                });
                
                if (!validRanks.has(card.rank)) {
                    socket.emit('error', { message: 'You can only add cards with ranks that are already on the battlefield' });
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
            
            // Set phase to defending if there are undefended attacks
            if (room.battlefield.some(pair => !pair.defense)) {
                room.gamePhase = 'defending';
            }
            
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
    
    // Defend against a specific attack
    socket.on('defendCard', (data) => {
        const { cardIndex, targetIndex } = data;
        const roomCode = playerRooms.get(socket.id);
        const room = gameRooms.get(roomCode);
        
        if (!room || room.gameState !== 'playing') return;
        if (room.currentDefenderId !== socket.id || room.gamePhase !== 'defending') return;
        
        const player = room.players.find(p => p.id === socket.id);
        if (!player || cardIndex >= player.hand.length) return;
        
        // Check if target attack exists and is undefended
        if (targetIndex >= room.battlefield.length || targetIndex < 0) return;
        if (room.battlefield[targetIndex].defense) {
            socket.emit('error', { message: 'This attack is already defended' });
            return;
        }
        
        const card = player.hand[cardIndex];
        const targetAttack = room.battlefield[targetIndex].attack;
        
        // Check if card can defend
        if (canDefend(card, targetAttack)) {
            room.battlefield[targetIndex].defense = card;
            player.hand.splice(cardIndex, 1);
            
            // Check if all attacks are defended
            if (room.battlefield.every(pair => pair.defense)) {
                // All defended, attackers can continue
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
            socket.emit('error', { message: 'This card cannot defend against that attack' });
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
        if (player.id !== room.initialAttackerId && player.id !== room.currentDefenderId && 
            player.isActive && !player.hasWon && !player.isSpectator) {
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
    if (initialAttacker && !initialAttacker.hasWon) {
        drawCardsForPlayer(room, initialAttacker);
    }
    
    // Draw for defender
    if (defender && !defender.hasWon) {
        drawCardsForPlayer(room, defender);
    }
    
    // Draw for other players in clockwise order
    room.players.forEach(player => {
        if (player.id !== room.initialAttackerId && player.id !== room.currentDefenderId && 
            player.isActive && !player.hasWon && !player.isSpectator) {
            drawCardsForPlayer(room, player);
        }
    });
    
    // Defender becomes new attacker, next player defends
    if (defender && !defender.hasWon && !defender.isSpectator) {
        room.initialAttackerId = defender.id;
        const nextDefender = getNextActivePlayer(room, defender.id);
        
        if (nextDefender) {
            room.currentDefenderId = nextDefender.id;
            room.additionalAttackers = getAttackers(room).filter(p => p.id !== room.initialAttackerId).map(p => p.id);
            room.gamePhase = 'attacking';
        } else {
            // No valid next defender, check if game should end
            console.log('No next defender available after successful defense');
        }
    } else {
        // Defender has won or is spectator, find next valid attacker
        const nextAttacker = getNextActivePlayer(room, room.currentDefenderId);
        if (nextAttacker) {
            room.initialAttackerId = nextAttacker.id;
            const nextDefender = getNextActivePlayer(room, nextAttacker.id);
            if (nextDefender) {
                room.currentDefenderId = nextDefender.id;
                room.additionalAttackers = getAttackers(room).filter(p => p.id !== room.initialAttackerId).map(p => p.id);
                room.gamePhase = 'attacking';
            }
        }
    }
    
    // Update player order
    updatePlayerOrder(room);
    
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

// Complete voting phase
function completeVoting(room) {
    // Clear vote timer if it exists
    if (room.voteTimer) {
        clearTimeout(room.voteTimer);
        room.voteTimer = null;
    }
    
    // Count yes votes
    const yesVotes = Array.from(room.playAgainVotes.values()).filter(v => v).length;
    const totalPlayers = room.players.filter(p => !p.isSpectator).length;
    
    if (yesVotes >= MIN_PLAYERS) {
        // Reset for new game
        resetRoomForNewGame(room);
        
        io.to(room.code).emit('newGameStarting', {
            gameState: getSafeGameState(room, null),
            yesVotes: yesVotes,
            totalVotes: totalPlayers
        });
    } else {
        // Not enough votes, room stays in finished state
        room.gameState = 'finished';
        
        io.to(room.code).emit('votingComplete', {
            result: 'ended',
            yesVotes: yesVotes,
            totalVotes: totalPlayers
        });
        
        // Clean up room after 10 seconds
        setTimeout(() => {
            cleanupRoom(room.code);
        }, 10000);
    }
}

// Check for game end
function checkGameEnd(room) {
    const activePlayers = room.players.filter(p => p.isActive && !p.hasWon && !p.isSpectator);
    
    if (room.deck.length === 0) {
        // Check if only one player has cards left
        const playersWithCards = activePlayers.filter(p => p.hand.length > 0);
        
        if (playersWithCards.length <= 1) {
            room.gameState = 'voting';
            room.gamePhase = 'voting';
            room.voteDeadline = Date.now() + VOTE_TIMEOUT;
            
            // Last player with cards is the Durak (loser)
            let durak = null;
            if (playersWithCards.length === 1) {
                durak = playersWithCards[0];
            }
            
            io.to(room.code).emit('gameOver', {
                durak: durak ? {
                    id: durak.id,
                    name: durak.name
                } : null,
                winners: room.winners,
                roundNumber: room.roundNumber
            });
            
            // Start vote timer
            room.voteTimer = setTimeout(() => {
                // Auto-complete voting if time runs out
                completeVoting(room);
            }, VOTE_TIMEOUT);
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
