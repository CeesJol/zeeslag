# Zeeslag

Battleship for two players, each on their own laptop. Static site, no own server: the two browsers exchange messages through two public MQTT brokers (HiveMQ and EMQX) at the same time. The game numbers and acknowledges its messages, so a lost or doubled message does no harm.

Rules: 10×10, ships 5, 4, 3, 3, 2, ships may not touch (also not diagonally), one shot per turn (a hit gives no extra shot), random starter, score kept over rounds.

## Run locally

```sh
npm start   # http://localhost:8765
npm test
```

## Host

Any static host works (for example GitHub Pages). Serve the folder as it is.
