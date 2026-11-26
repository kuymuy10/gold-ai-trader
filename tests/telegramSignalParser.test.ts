import assert from 'node:assert/strict';
import { parseTelegramSignal } from '../src/utils/telegramSignalParser.ts';

function run() {
  // 1. Standard XAUUSD BUY with Entry, SL, TP1, TP2, TP3
  const sig1 = parseTelegramSignal(
    `🔥 XAUUSD BUY @ 2650.50\nSL: 2642.00\nTP1: 2658.00\nTP2: 2665.00\nTP3: 2675.00`
  );
  assert.equal(sig1.isSignal, true);
  assert.equal(sig1.pair, 'XAUUSD');
  assert.equal(sig1.direction, 'BUY');
  assert.equal(sig1.entry, 2650.5);
  assert.equal(sig1.sl, 2642);
  assert.equal(sig1.tp1, 2658);
  assert.equal(sig1.tp2, 2665);
  assert.equal(sig1.tp3, 2675);

  // 2. GOLD alias SELL NOW with market execution and multiple TPs on one line
  const sig2 = parseTelegramSignal(
    `GOLD SELL NOW\nStop Loss: 2698\nTP: 2682 / 2674 / 2660`
  );
  assert.equal(sig2.isSignal, true);
  assert.equal(sig2.pair, 'XAUUSD');
  assert.equal(sig2.direction, 'SELL');
  assert.equal(sig2.entry, null);
  assert.equal(sig2.entryIsMarket, true);
  assert.equal(sig2.sl, 2698);
  assert.equal(sig2.tp1, 2682);
  assert.equal(sig2.tp2, 2674);
  assert.equal(sig2.tp3, 2660);

  // 3. Forex slash pair EUR/USD
  const sig3 = parseTelegramSignal(
    `SELL EUR/USD 1.0850\nSL 1.0890\nTP1 1.0810\nTP2 1.0770`
  );
  assert.equal(sig3.isSignal, true);
  assert.equal(sig3.pair, 'EURUSD');
  assert.equal(sig3.direction, 'SELL');
  assert.equal(sig3.entry, 1.085);
  assert.equal(sig3.sl, 1.089);
  assert.equal(sig3.tp1, 1.081);
  assert.equal(sig3.tp2, 1.077);
  assert.equal(sig3.tp3, null);

  // 4. Crypto BTCUSD BUY with range entry
  const sig4 = parseTelegramSignal(
    `BTCUSD BUY\nEntry: 91500 - 91700\nSL: 90200\nTP1: 92800\nTP2: 94000\nTP3: 96000`
  );
  assert.equal(sig4.isSignal, true);
  assert.equal(sig4.pair, 'BTCUSD');
  assert.equal(sig4.direction, 'BUY');
  assert.equal(sig4.entry, 91600);
  assert.equal(sig4.sl, 90200);
  assert.equal(sig4.tp1, 92800);
  assert.equal(sig4.tp2, 94000);
  assert.equal(sig4.tp3, 96000);

  // 5. Normal chat message MUST NOT be parsed as a signal
  const msgNormal1 = parseTelegramSignal('Good morning traders! London session opens in 15 mins.');
  assert.equal(msgNormal1.isSignal, false);

  // 6. Trade recap / TP hit message MUST NOT be parsed as a new signal
  const msgRecap = parseTelegramSignal('XAUUSD BUY hit TP2 for +120 pips! Book profits now.');
  assert.equal(msgRecap.isSignal, false);

  // 7. Management update without full SL/TP setup MUST NOT be traded
  const msgManage = parseTelegramSignal('Move SL to BE on EURUSD SELL and close half.');
  assert.equal(msgManage.isSignal, false);

  // 8. Malformed BUY levels (SL above Entry) MUST be rejected
  const msgBad = parseTelegramSignal('XAUUSD BUY @ 2650\nSL: 2660\nTP1: 2670');
  assert.equal(msgBad.isSignal, false);

  console.log('All Telegram Signal Parser assertions passed!');
}

run();
