'use strict';

var assert = require('assert');
var BN = require('bn.js');
var consensus = require('../lib/protocol/consensus');
var co = require('../lib/utils/co');
var Coin = require('../lib/primitives/coin');
var Script = require('../lib/script/script');
var Chain = require('../lib/blockchain/chain');
var Miner = require('../lib/mining/miner');
var MTX = require('../lib/primitives/mtx');
var MemWallet = require('./util/memwallet');
var util = require('../lib/utils/util');

describe('Chain', function() {
  var chain = new Chain({ db: 'memory', network: 'regtest' });
  var miner = new Miner({ chain: chain });
  var wallet = new MemWallet({ network: 'regtest' });
  var tip1, tip2, cb1, cb2, mineBlock;

  this.timeout(5000);

  mineBlock = co(function* mineBlock(tip, tx) {
    var attempt = yield miner.createBlock(tip);
    var rtx;

    if (!tx)
      return yield attempt.mineAsync();

    rtx = new MTX();

    rtx.addTX(tx, 0);

    rtx.addOutput(wallet.getReceive(), 25 * 1e8);
    rtx.addOutput(wallet.getChange(), 5 * 1e8);

    rtx.setLocktime(chain.height);

    wallet.sign(rtx);

    attempt.addTX(rtx.toTX(), rtx.view);

    return yield attempt.mineAsync();
  });

  chain.on('connect', function(entry, block) {
    wallet.addBlock(entry, block.txs);
  });

  chain.on('disconnect', function(entry, block) {
    wallet.removeBlock(entry, block.txs);
  });

  it('should open chain and miner', co(function* () {
    consensus.COINBASE_MATURITY = 0;
    yield chain.open();
    yield miner.open();
  }));

  it('should open wallet', co(function* () {
    miner.addresses.length = 0;
    miner.addAddress(wallet.getReceive());
  }));

  it('should mine a block', co(function* () {
    var block = yield miner.mineBlock();
    assert(block);
    yield chain.add(block);
  }));

  it('should mine competing chains', co(function* () {
    var i, block1, block2;

    for (i = 0; i < 10; i++) {
      block1 = yield mineBlock(tip1, cb1);
      cb1 = block1.txs[0];

      block2 = yield mineBlock(tip2, cb2);
      cb2 = block2.txs[0];

      yield chain.add(block1);

      yield chain.add(block2);

      assert(chain.tip.hash === block1.hash('hex'));

      tip1 = yield chain.db.getEntry(block1.hash('hex'));
      tip2 = yield chain.db.getEntry(block2.hash('hex'));

      assert(tip1);
      assert(tip2);

      assert(!(yield tip2.isMainChain()));

      yield co.wait();
    }
  }));

  it('should have correct chain value', function() {
    assert.equal(chain.db.state.value, 55000000000);
    assert.equal(chain.db.state.coin, 20);
    assert.equal(chain.db.state.tx, 21);
  });

  it('should have correct balance', co(function* () {
    assert.equal(wallet.balance, 550 * 1e8);
    //assert.equal(wallet.unconfirmed, 550 * 1e8);
    //assert.equal(wallet.confirmed, 550 * 1e8);
  }));

  it('should handle a reorg', co(function* () {
    var entry, block, forked;

    // assert.equal(wallet.height, chain.height);
    assert.equal(chain.height, 11);

    entry = yield chain.db.getEntry(tip2.hash);
    assert(entry);
    assert(chain.height === entry.height);

    block = yield miner.mineBlock(entry);
    assert(block);

    forked = false;
    chain.once('reorganize', function() {
      forked = true;
    });

    yield chain.add(block);

    assert(forked);
    assert(chain.tip.hash === block.hash('hex'));
    assert(chain.tip.chainwork.cmp(tip1.chainwork) > 0);
  }));

  it('should have correct chain value', function() {
    assert.equal(chain.db.state.value, 60000000000);
    assert.equal(chain.db.state.coin, 21);
    assert.equal(chain.db.state.tx, 22);
  });

  it('should have correct balance', co(function* () {
    assert.equal(wallet.balance, 600 * 1e8);
    // assert.equal(wallet.unconfirmed, 1100 * 1e8);
    // assert.equal(wallet.confirmed, 600 * 1e8);
  }));

  it('should check main chain', co(function* () {
    var result = yield tip1.isMainChain();
    assert(!result);
  }));

  it('should mine a block after a reorg', co(function* () {
    var block = yield mineBlock(null, cb2);
    var entry, result;

    yield chain.add(block);

    entry = yield chain.db.getEntry(block.hash('hex'));
    assert(entry);
    assert(chain.tip.hash === entry.hash);

    result = yield entry.isMainChain();
    assert(result);
  }));

  it('should prevent double spend on new chain', co(function* () {
    var block = yield mineBlock(null, cb2);
    var tip = chain.tip;
    var err;

    try {
      yield chain.add(block);
    } catch (e) {
      err = e;
    }

    assert(err);
    assert.equal(err.reason, 'bad-txns-inputs-missingorspent');
    assert(chain.tip === tip);
  }));

  it('should fail to mine a block with coins on an alternate chain', co(function* () {
    var block = yield mineBlock(null, cb1);
    var tip = chain.tip;
    var err;

    try {
      yield chain.add(block);
    } catch (e) {
      err = e;
    }

    assert(err);
    assert.equal(err.reason, 'bad-txns-inputs-missingorspent');
    assert(chain.tip === tip);
  }));

  it('should have correct chain value', function() {
    assert.equal(chain.db.state.value, 65000000000);
    assert.equal(chain.db.state.coin, 23);
    assert.equal(chain.db.state.tx, 24);
  });

  it('should get coin', co(function* () {
    var block, tx, output, coin;

    block = yield mineBlock();
    yield chain.add(block);

    block = yield mineBlock(null, block.txs[0]);
    yield chain.add(block);

    tx = block.txs[1];
    output = Coin.fromTX(tx, 1, chain.height);

    coin = yield chain.db.getCoin(tx.hash('hex'), 1);

    assert.deepEqual(coin.toRaw(), output.toRaw());
  }));

  it('should get balance', co(function* () {
    var txs;

    assert.equal(wallet.balance, 750 * 1e8);
    // assert.equal(wallet.unconfirmed, 1250 * 1e8);
    // assert.equal(wallet.confirmed, 750 * 1e8);

    assert(wallet.receiveDepth >= 7);
    assert(wallet.changeDepth >= 6);

    // assert.equal(wallet.height, chain.height);

    // txs = wallet.getHistory();
    // assert.equal(txs.length, 45);
    assert.equal(wallet.txs, 26);
  }));

  it('should get tips and remove chains', co(function* () {
    var tips = yield chain.db.getTips();

    assert.notEqual(tips.indexOf(chain.tip.hash), -1);
    assert.equal(tips.length, 2);

    yield chain.db.removeChains();

    tips = yield chain.db.getTips();

    assert.notEqual(tips.indexOf(chain.tip.hash), -1);
    assert.equal(tips.length, 1);
  }));

  it('should rescan for transactions', co(function* () {
    var total = 0;

    yield chain.db.scan(0, wallet.filter, function(block, txs) {
      total += txs.length;
      return Promise.resolve();
    });

    assert.equal(total, 26);
  }));

  it('should activate csv', co(function* () {
    var deployments = chain.network.deployments;
    var i, block, prev, state, cache;

    prev = yield chain.tip.getPrevious();
    state = yield chain.getState(prev, deployments.csv);
    assert(state === 0);

    for (i = 0; i < 417; i++) {
      block = yield miner.mineBlock();
      yield chain.add(block);
      switch (chain.height) {
        case 144:
          prev = yield chain.tip.getPrevious();
          state = yield chain.getState(prev, deployments.csv);
          assert(state === 1);
          break;
        case 288:
          prev = yield chain.tip.getPrevious();
          state = yield chain.getState(prev, deployments.csv);
          assert(state === 2);
          break;
        case 432:
          prev = yield chain.tip.getPrevious();
          state = yield chain.getState(prev, deployments.csv);
          assert(state === 3);
          break;
      }
    }

    assert(chain.height === 432);
    assert(chain.state.hasCSV());

    cache = yield chain.db.getStateCache();
    assert.deepEqual(cache, chain.db.stateCache);
    assert.equal(chain.db.stateCache.updates.length, 0);
    assert(yield chain.db.verifyDeployments());
  }));

  var mineCSV = co(function* mineCSV(tx) {
    var attempt = yield miner.createBlock();
    var redeemer;

    redeemer = new MTX();

    redeemer.addOutput({
      script: [
        Script.array(new BN(1)),
        Script.opcodes.OP_CHECKSEQUENCEVERIFY
      ],
      value: 10 * 1e8
    });

    redeemer.addTX(tx, 0);

    redeemer.setLocktime(chain.height);

    wallet.sign(redeemer);

    attempt.addTX(redeemer.toTX(), redeemer.view);

    return yield attempt.mineAsync();
  });

  it('should test csv', co(function* () {
    var tx = (yield chain.db.getBlock(chain.height)).txs[0];
    var block = yield mineCSV(tx);
    var csv, attempt, redeemer;

    yield chain.add(block);

    csv = block.txs[1];

    redeemer = new MTX();

    redeemer.addOutput({
      script: [
        Script.array(new BN(2)),
        Script.opcodes.OP_CHECKSEQUENCEVERIFY
      ],
      value: 10 * 1e8
    });

    redeemer.addTX(csv, 0);
    redeemer.setSequence(0, 1, false);

    attempt = yield miner.createBlock();

    attempt.addTX(redeemer.toTX(), redeemer.view);

    block = yield attempt.mineAsync();

    yield chain.add(block);
  }));

  it('should fail csv with bad sequence', co(function* () {
    var csv = (yield chain.db.getBlock(chain.height)).txs[1];
    var block, attempt, redeemer, err;

    redeemer = new MTX();

    redeemer.addOutput({
      script: [
        Script.array(new BN(1)),
        Script.opcodes.OP_CHECKSEQUENCEVERIFY
      ],
      value: 10 * 1e8
    });

    redeemer.addTX(csv, 0);
    redeemer.setSequence(0, 1, false);

    attempt = yield miner.createBlock();

    attempt.addTX(redeemer.toTX(), redeemer.view);

    block = yield attempt.mineAsync();

    try {
      yield chain.add(block);
    } catch (e) {
      err = e;
    }

    assert(err);
    assert(err.reason, 'mandatory-script-verify-flag-failed');
  }));

  it('should mine a block', co(function* () {
    var block = yield miner.mineBlock();
    assert(block);
    yield chain.add(block);
  }));

  it('should fail csv lock checks', co(function* () {
    var tx = (yield chain.db.getBlock(chain.height)).txs[0];
    var block = yield mineCSV(tx);
    var csv, attempt, redeemer, err;

    yield chain.add(block);

    csv = block.txs[1];

    redeemer = new MTX();

    redeemer.addOutput({
      script: [
        Script.array(new BN(2)),
        Script.opcodes.OP_CHECKSEQUENCEVERIFY
      ],
      value: 10 * 1e8
    });

    redeemer.addTX(csv, 0);
    redeemer.setSequence(0, 2, false);

    attempt = yield miner.createBlock();

    attempt.addTX(redeemer.toTX(), redeemer.view);

    block = yield attempt.mineAsync();

    try {
      yield chain.add(block);
    } catch (e) {
      err = e;
    }

    assert(err);
    assert.equal(err.reason, 'bad-txns-nonfinal');
  }));

  it('should have correct wallet balance', co(function* () {
    assert.equal(wallet.balance, 1289250000000);
  }));

  it('should cleanup', co(function* () {
    consensus.COINBASE_MATURITY = 100;
    yield miner.close();
    yield chain.close();
  }));
});
