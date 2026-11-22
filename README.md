# Zeeslag

Battleship for two players, each on their own laptop. Static site, no server: the two browsers connect peer-to-peer with [PeerJS](https://peerjs.com) (its free cloud server only does the handshake).

Rules: 10×10, ships 5, 4, 3, 3, 2, ships may not touch (also not diagonally), one shot per turn (a hit gives no extra shot), random starter, score kept over rounds.

## Run locally

```sh
npm start   # http://localhost:8765
npm test
```

## Host

Any static host works (for example GitHub Pages). Serve the folder as it is.
