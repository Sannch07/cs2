// server.js
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const session = require('express-session');
const passport = require('passport');
const SteamStrategy = require('passport-steam').Strategy;
const LocalStrategy = require('passport-local').Strategy;
const port = 3000;

app.use(express.static(__dirname)); // Serve static files like style.css
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const sessionMiddleware = session({
  secret: 'your-secret-key', // Change this to a secure secret
  resave: false,
  saveUninitialized: false
});

app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/Game.html'); // Serve Game.html at root
});

// Mock user data storage (in-memory for simplicity)
const users = {};
const games = {}; // { gameId: { gameId, player1: {user, choice, bet, isSkin}, player2: {user, choice, bet, isSkin}, status: 'waiting|ongoing|finished', result: null } }
let gameIdCounter = 1;

// Mock skins inventory per user - added more CSGO skins
const mockSkins = [
    { id: 1, name: 'AK-47 | Redline', value: 50, image: 'https://example.com/ak-redline.png' },
    { id: 2, name: 'AWP | Asiimov', value: 100, image: 'https://example.com/awp-asiimov.png' },
    { id: 3, name: 'M4A4 | Howl', value: 200, image: 'https://example.com/m4a4-howl.png' },
    { id: 4, name: 'Glock-18 | Fade', value: 300, image: 'https://example.com/glock-fade.png' },
    { id: 5, name: 'USP-S | Kill Confirmed', value: 150, image: 'https://example.com/usp-kill.png' },
    { id: 6, name: 'Knife | Doppler', value: 500, image: 'https://example.com/knife-doppler.png' }
];

// Passport serialization
passport.serializeUser((user, done) => {
    done(null, user.username);
});

passport.deserializeUser((username, done) => {
    done(null, users[username]);
});

// Local Strategy for username/password
passport.use(new LocalStrategy(
    (username, password, done) => {
        const user = users[username];
        if (!user || user.password !== password) {
            return done(null, false);
        }
        return done(null, user);
    }
));

// Steam Strategy
passport.use(new SteamStrategy({
    returnURL: 'http://localhost:3000/auth/steam/return',
    realm: 'http://localhost:3000/',
    apiKey: 'DE52A7384B4B9241FE48CA7DD3EC288E' // Your provided API key
}, (identifier, profile, done) => {
    const steamId = profile.id;
    let user = Object.values(users).find(u => u.steamId === steamId);
    if (!user) {
        let username = profile.displayName;
        let i = 1;
        while (users[username]) {
            username = profile.displayName + i;
            i++;
        }
        user = {
            username,
            steamId,
            avatar: profile.photos[2].value, // Large avatar
            balance: 1000,
            skins: mockSkins.slice(0, 3)
        };
        users[username] = user;
    }
    return done(null, user);
}));

// Auth routes
app.post('/register', (req, res) => {
    const { username, email, password } = req.body;
    if (users[username]) {
        return res.status(400).send('Username taken');
    }
    users[username] = {
        username,
        email,
        password, // In production, hash this
        balance: 1000,
        skins: mockSkins.slice(0, 3)
    };
    req.login(users[username], (err) => {
        if (err) return res.status(500).send('Error');
        res.redirect('/');
    });
});

app.post('/login', passport.authenticate('local', { failureRedirect: '/' }), (req, res) => {
    res.redirect('/');
});

app.get('/auth/steam', passport.authenticate('steam'));

app.get('/auth/steam/return', passport.authenticate('steam', { failureRedirect: '/' }), (req, res) => {
    res.redirect('/');
});

app.get('/logout', (req, res) => {
    req.logout((err) => {
        if (err) return next(err);
        res.redirect('/');
    });
});

// Socket.io setup with authentication
const onlyForHandshake = (middleware) => (req, res, next) => {
    if (req._query.sid) {
        return next();
    }
    middleware(req, res, next);
};

io.engine.use(onlyForHandshake(sessionMiddleware));
io.engine.use(onlyForHandshake(passport.initialize()));
io.engine.use(onlyForHandshake(passport.session()));

io.use((socket, next) => {
    if (socket.request.user) {
        next();
    } else {
        next(new Error('unauthorized'));
    }
});

io.on('connection', (socket) => {
    console.log('a user connected');
    const user = socket.request.user;
    if (user) {
        users[user.username].socketId = socket.id;
        socket.emit('auth_success', { username: user.username, balance: user.balance, skins: user.skins, avatar: user.avatar });
    }

    socket.on('create_game', (data) => {
        if (!user) return;
        const gameId = gameIdCounter++;
        games[gameId] = {
            gameId,
            player1: { user: user.username, choice: data.choice, bet: data.bet, isSkin: data.isSkin },
            player2: null,
            status: 'waiting',
            result: null
        };
        socket.emit('game_created', { gameId });
        io.emit('game_list_update', Object.values(games).filter(g => g.status === 'waiting'));
    });

    socket.on('join_game', (data) => {
        if (!user) return;
        const game = games[data.gameId];
        if (game && game.status === 'waiting' && game.player1.user !== user.username) {
            if (data.choice === game.player1.choice) {
                return socket.emit('join_error', 'Choose the opposite side');
            }
            game.player2 = { user: user.username, choice: data.choice, bet: data.bet, isSkin: data.isSkin };
            game.status = 'ongoing';
            io.to(users[game.player1.user].socketId).emit('game_started', game);
            socket.emit('game_started', game);
            // Simulate flip
            setTimeout(() => {
                const sides = ['ct', 't'];
                game.result = sides[Math.floor(Math.random() * 2)];
                game.status = 'finished';
                determineWinner(game);
                io.to(users[game.player1.user].socketId).emit('game_result', game);
                io.to(users[game.player2.user].socketId).emit('game_result', game);
                io.emit('game_list_update', Object.values(games).filter(g => g.status === 'waiting'));
            }, 5000);
        } else {
            socket.emit('join_error', 'Cannot join this game');
        }
    });

    socket.on('get_game_list', () => {
        socket.emit('game_list_update', Object.values(games).filter(g => g.status === 'waiting'));
    });

    socket.on('chat_message', (data) => {
        io.emit('chat_message', { username: user.username, message: data.message });
    });

    socket.on('disconnect', () => {
        console.log('user disconnected');
    });
});

function determineWinner(game) {
    const winnerChoice = game.result;
    const loserChoice = winnerChoice === 'ct' ? 't' : 'ct';
    const winner = game.player1.choice === winnerChoice ? game.player1 : game.player2;
    const loser = game.player1.choice === loserChoice ? game.player1 : game.player2;

    if (game.player1.isSkin && game.player2.isSkin) {
        // Transfer skin from loser to winner
        const loserSkinIndex = users[loser.user].skins.findIndex(s => s.id === loser.bet.id);
        if (loserSkinIndex > -1) {
            const skin = users[loser.user].skins.splice(loserSkinIndex, 1)[0];
            users[winner.user].skins.push(skin);
        }
    } else if (!game.player1.isSkin && !game.player2.isSkin) {
        // Transfer balance
        users[winner.user].balance += Math.min(game.player1.bet, game.player2.bet) * 2; // Assume matched bets for simplicity
        users[loser.user].balance -= Math.min(game.player1.bet, game.player2.bet);
    } else {
        // Mixed bets - for simplicity, skip or handle as error, but assume same type
    }

    // Update clients
    io.to(users[winner.user].socketId).emit('update_balance_skins', { balance: users[winner.user].balance, skins: users[winner.user].skins });
    io.to(users[loser.user].socketId).emit('update_balance_skins', { balance: users[loser.user].balance, skins: users[loser.user].skins });
}

http.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});