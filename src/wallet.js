const EC = require('elliptic').ec;
const fs = require('fs');
const path = require('path');

const ec = new EC('secp256k1');
const WALLET_DIR = path.join(__dirname, 'wallets');

if (!fs.existsSync(WALLET_DIR)) {
  fs.mkdirSync(WALLET_DIR);
}

function createNewWallet() {
  const key = ec.genKeyPair();
  const publicKey = key.getPublic('hex');
  const privateKey = key.getPrivate('hex');

  // Save the wallet to a file
  const walletPath = path.join(WALLET_DIR, `${publicKey}.json`);
  fs.writeFileSync(walletPath, JSON.stringify({ publicKey, privateKey }));

  console.log(`New wallet created with address: ${publicKey}`);
  return { publicKey, privateKey };
}

function loadWallet(publicKey) {
  const walletPath = path.join(WALLET_DIR, `${publicKey}.json`);
  if (!fs.existsSync(walletPath)) {
    throw new Error('Wallet not found.');
  }

  const walletData = JSON.parse(fs.readFileSync(walletPath, 'utf8'));
  return walletData;
}

module.exports = { createNewWallet, loadWallet, ec };


