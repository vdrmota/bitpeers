var express = require('express')
const pg = require('pg');
var app = express();
var http = require('http').Server(app);
var io = require('socket.io')(http);
var broadcast = require('./broadcast.js')
var register = require('./register.js')
var sign = require('./sign.js')
var oracle = require('./oracle.js')
var config = require('./config.js')
var blockchain = require('./blockchain.js')

// db params
var connectionString = process.env.DATABASE_URL || 'postgres://localhost:5432/betcafe'
var client = new pg.Client(connectionString)

function getMatches(dict)
{
	var flags = []
	var output = []

	for (var key in dict) 
	{
		if (typeof flags[dict[key]] !== "undefined")
			continue
		flags[dict[key]] = true
		if (dict[key].length != 0)
			output.push(dict[key])
	}

	return output
}

/* 
This runs the oracle
Results are broadcasted to blockchain
Run it every x seconds
Run it for each server
Include player balances
-->Move this into the sockets<--
*/

setInterval(function(){

		var matches = getMatches(serverToGame)
		console.log(matches)

		// !for each of this matches, run oracle -> only one per game
		// send servers and balances
		// send out new balances after
		matches.forEach(function(match) {
			oracle.oracle(match, addressToUsername)
		})
}, 20000)

app.engine('html', require('ejs').renderFile);
app.set('view engine', 'html');
app.use(express.static(__dirname + '/public'));

var servers = []
var serverToGame = {}
var addressToUsername = {}
var usernameToAddress = {}
var usernameToPrivate = {}
var bets = []
var _bets = []
var all_bets = []
var serverToPlayers = {}
var usernameToBalance = {}
var serverToCoinbase = {}
var playerToServer = {}
var users = []
var gameToCommentary = {}
var serverToEvents = {} // dictionary -> array -> dictionary
var socketToUsername = {}
var serverToDownvotes = {} // dictionary (server) -> dictionary (eventid) -> array (usernames of players who downvoted)
var socketToServer = {} // to know which server user disconnected from

/*
This is the bet countdown timer
*/

setInterval(function() {

	for (var key in serverToEvents)
	{
		for (var i = 0, n = serverToEvents[key].length; i < n; i++)
		{
			try {
			if (serverToEvents[key][i].timeRemaining == 0)
			{
				// if countdown is up, delete the event
				for (var j = 0, k = bets.length; j < k; j++)
				{
					if (bets[j].eventid == serverToEvents[key][i].eventid && bets[j].server == key)
					{
						console.log("KEY "+key) // key = server
						io.sockets.to(key).emit('delete pending bet timer', serverToEvents[key][i].eventid, bets[j].username, bets[j].amount)
						usernameToBalance[bets[j].username] = parseFloat(usernameToBalance[bets[j].username]) + parseFloat(bets[j].amount)
						bets.splice(j, 1)
					}
				}
				serverToEvents[key].splice(i, 1)
				console.log(serverToEvents)
			}
			else
			{
				io.sockets.to(key).emit('tick', serverToEvents[key][i].eventid, serverToEvents[key][i].timeRemaining)
				serverToEvents[key][i].timeRemaining -= 1
			}
			} catch (err) { console.log("ERR: "+ err)}
		}
	}

}, 1000)

app.get("/", function(req, res){
	console.log(servers)
	res.render(__dirname + '/server/masterserver.html', { servers: servers })
})

app.get("/play", function(req, res) {
	res.render(__dirname + '/server/openplay.html', { server: req.query.server, matchid: serverToGame[req.query.server], commentary: gameToCommentary[serverToGame[req.query.server]], players: serverToPlayers[req.query.server], coinbase: serverToCoinbase[req.query.server], balances: JSON.stringify(usernameToBalance) })
})

io.on('connection', function (socket) {

	console.log('New connection.');

	// when receiving an updated blockchain, emit it to all nodes
	socket.on('emit_blockchain', function (blockchain) {
		// emit to all nodes
		io.sockets.emit('receive_blockchain', blockchain[0])
		console.log("Emitting new state of blockchain...")
	});

	// when receiving a new transaction to be added to mempools, emit it to all nodes
	socket.on('emit_transaction', function (transaction) {
		// emit to all nodes
		io.sockets.emit('receive_transaction', transaction[0])
		console.log("Emitting new transaction...")
	});

	// when receiving an ask
	socket.on('ask', function () {
		// emit to all nodes
		io.sockets.emit('send_hash', socket.id)
		console.log("Asking for hashes...")
	});

	// when receiving hashes -> emit them to the asking client
	socket.on('emit_hash', function (id, hash) {
		socket.to(id).emit('receive_hash', hash, socket.id);
		console.log("Sending hash...")
		console.log(hash)
	});

	// when asking specific node for chain
	socket.on('ask_node', function (id) {
		socket.to(id).emit('send_chain', socket.id)
		console.log("Asking specific node for chain...")
	});

	// when sending chain from specific node
	socket.on('emit_chain_from_node', function (chain, id) {
		socket.to(id).emit('receive_chain_from_node', chain)
		console.log("Sending specific chain to node...")
	});

	/* Begin handling UI events */

	socket.on('create game', function (servername, gameid) {
		// if server with this name already exists, return error
		if (servers.indexOf(servername) != -1)
			io.sockets.to(socket.id).emit('error message', 'This room already exists.')
		else
		{
			servers.push(servername)
			serverToGame[servername] = gameid
			serverToPlayers[servername] = []
			serverToCoinbase[servername] = 0
			gameToCommentary[gameid] ? 1 : gameToCommentary[gameid] = []
			console.log(serverToPlayers)
		}
	})

	socket.on('disconnect', function() {

		try {
		// remove player from server count
		var identify = serverToPlayers[socketToServer[socket.id]] 
		identify.splice(identify.indexOf(socketToUsername[socket.id]), 1)

		var server = socketToServer[socket.id] 
		var username = socketToUsername[socket.id]

		// remove this player's potential vote and remove him from total count
		for (var el_eventid in serverToDownvotes[server]) {
			if (serverToDownvotes[server][el_eventid].indexOf(username) != -1)
			{
				serverToDownvotes[server][el_eventid].splice(serverToDownvotes[server][el_eventid].indexOf(username), 1)
			}
			io.sockets.to(server).emit('receive downvote bet', el_eventid, serverToDownvotes[server][el_eventid].length, serverToPlayers[server].length)
		
			if (serverToDownvotes[server][el_eventid].length >= serverToPlayers[server].length) // this determines the threshold for downvotes
			{
				// an active bet should be deleted
				io.sockets.to(server).emit('delete active bet', el_eventid)
				serverToDownvotes[server][el_eventid] ? serverToDownvotes[server][el_eventid] = [] : 1

				// generate transfer back transaction
				// iterate through _bets and retrieve information
				var _generate = all_bets.filter(function(bet) { return bet.server == server && bet.eventid == el_eventid })
				var _from = []
				var _to = []
				var _amount = []
				for (var i = 0, n = _generate.length; i < n; i++)
				{
					_from.push(usernameToAddress[_generate[i].username])
					_to.push(usernameToAddress[_generate[i].username])
					_amount.push(_generate[i].amount)

					// update at every server where player is
					playerToServer[_generate[i].username].forEach(function(_server) {
						io.sockets.to(_server).emit('update client balances', el_eventid, _generate[i].username, _generate[i].amount)
					})
					usernameToBalance[_generate[i].username] = parseFloat(usernameToBalance[_generate[i].username]) + parseFloat(_generate[i].amount)
				}

				broadcast.transaction("transfer", el_eventid, _from, _to, _amount, [], server, serverToGame[server], [], Date.now(), config.mempoolFile)

				_bets = _bets.filter(function(bet) { return !(bet.server == server && bet.eventid == el_eventid) })
				all_bets = all_bets.filter(function(bet) { return !(bet.server == server && bet.eventid == el_eventid) })
				bets = bets.filter(function(bet) { return !(bet.server == server && bet.eventid == el_eventid) })
			}
		}

		// remove this player's bets
		//_bets = _bets.filter(function(bet) { return !(bet.server == server && bet.username == username) })
		//all_bets = all_bets.filter(function(bet) { return !(bet.server == server && bet.username == username) })
		bets = bets.filter(function(bet) { return !(bet.server == server && bet.username == username) })

		// tell other players in server about disconnect
		io.sockets.to(server).emit('player disconnected', username)
		} catch (err) {  }
	})

	socket.on('lookup active bets', function (server) {

		__bets = _bets.filter(function(bet) { return bet.server == server })

		io.sockets.to(socket.id).emit('return lookup active bets', __bets)

	})

	socket.on('ask login', function (username, server) {
		if (users.indexOf(username) == -1)
		{
			io.sockets.to(socket.id).emit('error message', 'This username is not registered.')
		}
		else
		{
			socketToUsername[socket.id] = username
			socketToServer[socket.id] = server
			if (serverToPlayers[server].indexOf(username) != -1)
				io.sockets.to(socket.id).emit('login approved', true)
			else
				io.sockets.to(socket.id).emit('login approved', false)
		}
			
	})

	socket.on('ask bet overview', function (eventid, server, matchid) {

		__bets = all_bets.filter(function(bet){ return bet.server == server && bet.matchid == matchid && bet.eventid == eventid })
		io.sockets.to(socket.id).emit('receive bet overview', __bets)
	})

	socket.on('place pending bet', function (eventid, wager, username, server, matchid, amount, already) {
		// broadcast that the bet is pending
		if (already === false)
		{
			io.sockets.to(server).emit('receive pending bet', eventid, amount, username)
			serverToEvents[server] ? 1 : serverToEvents[server] = []
			serverToEvents[server].push({"eventid": eventid, "timeRemaining": 30 })
		}
		// update balances
		usernameToBalance[username] -= amount
		playerToServer[username].forEach(function(server) { // emit to each server that player is in
			io.sockets.to(server).emit('receive balances', usernameToBalance[username], username)
		})		
		// sign the bet -- signing here takes place serverside
		var signature = sign.sign(usernameToAddress[username], usernameToPrivate[username], amount)
		bets.push(
			{ "eventid": eventid, "amount": amount, "wager": wager, "username": username, "server": server, "matchid": matchid, "signature": signature }
		)
		all_bets.push(
			{ "eventid": eventid, "amount": amount, "wager": wager, "username": username, "server": server, "matchid": matchid, "signature": signature }
		)
		// check if bet is complete
		var betCount = 0
		for (var i = 0, n = bets.length; i < n; i++)
		{
			if (bets[i].server == server && bets[i].matchid == matchid && bets[i].eventid == eventid)
				betCount++
		}
		// everyone has placed a bet -> broadcast the bet
		if (betCount == serverToPlayers[server].length) // this defines the threshold for a pending bet to become active
		{
			io.sockets.to(server).emit('delete pending bet', eventid)
			io.sockets.to(server).emit('receive active bet', eventid, amount)
			// delete event from countdown
			for (var i = 0, n = serverToEvents[server].length; i < n; i++) 
			{
				if (serverToEvents[server][i].eventid == eventid)
				{
					serverToEvents[server].splice(i, 1)
					break
				}
			}
			var from = []
			var amount = []
			var wagers = []
			var signatures = []
			var timestamp = Date.now()

			for (var i = 0, n = bets.length; i < n; i++)
			{
				if (bets[i].server == server && bets[i].matchid == matchid && bets[i].eventid == eventid)
				{
					from.push(usernameToAddress[bets[i].username])
					amount.push(parseInt(bets[i].amount))
					wagers.push(bets[i].wager)
					signatures.push(bets[i].signature)
				}
			}
			broadcast.transaction("escrow", eventid, from, [], amount, wagers, server, matchid, signatures, timestamp, config.mempoolFile)
			// remove bets that have been broadcasted
			bets = bets.filter(function(bet){ return !(bet.server == server && bet.matchid == matchid && bet.eventid == eventid) })	
			// push into active bets
			_bets.push(
				{ "eventid": eventid, "amount": amount, "wager": wager, "username": username, "server": server, "matchid": matchid, "signature": signature }
			)
		}
	})

	socket.on('user register', function (username, password) {
		// register user with new public key (address)
		if (usernameToAddress[username])
			io.sockets.to(socket.id).emit('error message', 'This username is already taken. Please choose another username.')
		else
		{
			var address = register.register(username)
			addressToUsername[address[0]] = username
			usernameToAddress[username] = address[0]
			usernameToPrivate[username] = address[1]
			usernameToBalance[username] = blockchain.findStatement(usernameToAddress[username])[0] // save user balance
			users.push(username)

			// insert user into db
			client.query("INSERT INTO users (username, public, private, password) VALUES ($1,$2,$3,$4)",
				[username, address[0], address[1], password])
		}
		console.log(usernameToAddress)
	})

	socket.on('login user', function (username, server, alreadyLoggedIn) {
		// add unique player to server
		serverToPlayers[server] ? serverToPlayers[server].indexOf(username) == -1 ? serverToPlayers[server].push(username) : 1 : serverToPlayers[server] = [username]
		socket.join(server)
		if (usernameToAddress[username])
		{
			playerToServer[username] ? playerToServer[username].push(server) : playerToServer[username] = [server]

			io.sockets.to(socket.id).emit('receive address', usernameToAddress[username])

			if (!alreadyLoggedIn)
			{
				io.sockets.to(server).emit('receive login user', username, usernameToBalance[username])
			}
		}
		else
		{
			io.sockets.to(socket.id).emit('error message', 'This user does not exist.', 'login')
		}
	})

	socket.on('transfer balances', function (balances) {
		for (var i = 0, n = balances.length; i < n; i++)
		{
			usernameToBalance[balances[i].player] += balances[i].amount
			playerToServer[balances[i].player].forEach(function(server) { // emit to each server that player is in
				io.sockets.to(server).emit('receive balances', usernameToBalance[balances[i].player], balances[i].player)
			})
		}
	
		console.log(balances)
	})

	socket.on('send downvote bet', function (eventid, server, username) {
		serverToDownvotes[server] ? 1 : serverToDownvotes[server] = {}
		serverToDownvotes[server][eventid] ? 1 : serverToDownvotes[server][eventid] = []
		serverToDownvotes[server][eventid].push(username)

		io.sockets.to(server).emit('receive downvote bet', eventid, serverToDownvotes[server][eventid].length, serverToPlayers[server].length)

		if (serverToDownvotes[server][eventid].length >= serverToPlayers[server].length) // this determines the threshold for downvotes
		{
			// an active bet should be deleted
			io.sockets.to(server).emit('delete active bet', eventid)
			serverToDownvotes[server][eventid] ? serverToDownvotes[server][eventid] = [] : 1

			// generate transfer back transaction
			// iterate through _bets and retrieve information
			var _generate = all_bets.filter(function(bet) { return bet.server == server && bet.eventid == eventid })
			var _from = []
			var _to = []
			var _amount = []
			for (var i = 0, n = _generate.length; i < n; i++)
			{
				_from.push(usernameToAddress[_generate[i].username])
				_to.push(usernameToAddress[_generate[i].username])
				_amount.push(_generate[i].amount)

				// update balances at every server where player is
				playerToServer[_generate[i].username].forEach(function(_server) {
					io.sockets.to(_server).emit('update client balances', eventid, _generate[i].username, _generate[i].amount)
				})

				usernameToBalance[_generate[i].username] = parseFloat(usernameToBalance[_generate[i].username]) + parseFloat(_generate[i].amount)
			}

			broadcast.transaction("transfer", eventid, _from, _to, _amount, [], server, serverToGame[server], [], Date.now(), config.mempoolFile)
	
			_bets = _bets.filter(function(bet) { return !(bet.server == server && bet.eventid == eventid) })
			all_bets = all_bets.filter(function(bet) { return !(bet.server == server && bet.eventid == eventid) })
			bets = bets.filter(function(bet) { return !(bet.server == server && bet.eventid == eventid) })
		}
	})

	socket.on('lookup payout history', function () {
		for (var i = 0, n = servers.length; i < n; i++)
		{
			var payoutHistory = blockchain.getPayoutHistory(servers[i], addressToUsername)
			io.sockets.to(servers[i]).emit('receive payout history', payoutHistory)
		}
	})

	socket.on('send timer', function (minute, score, home, away, matchid, homeflag, awayflag) {
		for (var key in serverToGame)
		{
			if (serverToGame[key] == matchid)
				io.sockets.to(key).emit('receive timer', minute, score, home, away, homeflag, awayflag)
		}
	})

	socket.on('ask account statement', function(username) {
		var statement = blockchain.findStatement(usernameToAddress[username])
		var balance = statement[0]
		var history = statement[1]
		io.sockets.to(socket.id).emit('receive account statement', balance, history)
	})

	socket.on('send live commentary', function (minute, eventid, team, matchid) {
		for (var key in serverToGame)
		{
			if (serverToGame[key] == matchid)
				io.sockets.to(key).emit('receive live commentary', minute, eventid, team)
		}
		gameToCommentary[matchid].push(minute+"!:!"+eventid+"!:!"+team)
	})

	socket.on('do delete active bet', function (server, eventid) { // user balances have already been updated at this stage
		io.sockets.to(server).emit('delete active bet', eventid)
		serverToDownvotes[server] ? 1 : serverToDownvotes[server] = []
		serverToDownvotes[server][eventid] ? serverToDownvotes[server][eventid] = [] : 1
		_bets = _bets.filter(function(bet) { return !(bet.server == server && bet.eventid == eventid) })
		all_bets = all_bets.filter(function(bet) { return !(bet.server == server && bet.eventid == eventid) })
	})

	socket.on('new chat', function (username, server, message) {
		io.sockets.to(server).emit('receive new chat', username, message)
	})

	socket.on('get player counts', function () {
		io.sockets.to(socket.id).emit('receive player counts', serverToPlayers)
	})

	socket.on('ask my balance', function (_username) {
		io.sockets.to(socket.id).emit('receive my balance', usernameToBalance[_username])
	})

});

// retrieve all users from db
client.connect()
var query = client.query("SELECT * FROM users")
query.on('row', (row) => {
	addressToUsername[row["public"]] = row["username"]
	usernameToAddress[row["username"]] = row["public"]
	usernameToPrivate[row["username"]] = row["private"]
	users.push(row["username"])
	usernameToBalance[row["username"]] = blockchain.findStatement(usernameToAddress[row["username"]])[0] // save user balance
	console.log(users)
})

// start node server
var server = http.listen(1338, function () {
  console.log('listening on *:1338');
})
