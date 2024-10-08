'use strict';

const crypto = require('crypto'); // Required for creating cryptographic hashes
const EC = require('elliptic').ec; // Required for elliptic curve cryptography
const db = require('./db'); // Database module for interacting with the database
const { Node, MerkleTree } = require('./merkleTree'); // Importing MerkleTree and Node classes
const { acquireLock, releaseLock } = require('./lock'); // Assume lock.js handles locking mechanisms

const ec = new EC('secp256k1'); // Initialize the elliptic curve for cryptography

const redis = require('redis');
const client = redis.createClient();

client.on('error', (err) => {
  console.error('Redis Client Error', err);
});

client.connect();

class Transaction {
  constructor(fromAddress, toAddress, amount, timestamp = Date.now(), signature = null, blockHash = '') {
    this.fromAddress = fromAddress; // Address sending the funds
    this.toAddress = toAddress; // Address receiving the funds
    this.amount = amount; // Amount of funds being transferred
    this.timestamp = timestamp; // Timestamp of when the transaction was created
    this.signature = signature; // Digital signature for transaction validation
    this.blockHash = blockHash; // Hash of the block this transaction is included in (if any)
    this.hash = this.calculateHash(); // Calculate the transaction hash
  }

  // Calculate the hash of the transaction
  calculateHash() {
    return crypto.createHash('sha256')
      .update(this.fromAddress + this.toAddress + this.amount + this.timestamp)
      .digest('hex');
  }

  // Sign the transaction using the provided key pair
  sign(keyPair) {
    const hashTx = this.calculateHash(); // Get the hash of the transaction

    // Allow signing if no sender address is specified (e.g., for reward transactions)
  if (this.fromAddress && keyPair.getPublic('hex') !== this.fromAddress) {
      throw new Error('You cannot sign transactions for other wallets!');
    }

    const sig = keyPair.sign(hashTx, 'hex'); // Sign the transaction hash
    this.signature = sig.toDER('hex'); // Set the signature
  }

  // Validate the transaction
  isValid() {
    const hashToVerify = this.calculateHash(); // Calculate the hash to verify
    if (this.fromAddress === null) return true; // Allow transactions with no sender (e.g., mining reward)
    if (!this.signature || this.signature.length === 0) {
      return false; // Transaction must be signed
    }
    try {
      const key = ec.keyFromPublic(this.fromAddress, 'hex'); // Load the public key from the address
      return key.verify(hashToVerify, this.signature); // Verify the signature
    } catch (error) {
      return false; // If any error occurs, the transaction is invalid
    }
  }

  // Save the transaction to the database
  save() {
    return new Promise((resolve, reject) => {
      const query = 'INSERT INTO transactions (hash, from_address, to_address, amount, timestamp, signature, block_hash) VALUES (?, ?, ?, ?, ?, ?, ?)';
      const values = [this.hash, this.fromAddress, this.toAddress, this.amount, this.timestamp, this.signature, this.blockHash];
      db.query(query, values, (err, results) => {
        if (err) {
          return reject(err); // If there is an error, reject the promise
        }
        resolve(results); // Resolve with the database result
      });
    });
  }

  // Load a transaction from the database
  static async load(hash) {
    return new Promise((resolve, reject) => {
      const query = 'SELECT * FROM transactions WHERE hash = ?';
      db.query(query, [hash], (err, results) => {
        if (err) return reject(err); // If there is an error, reject the promise
        if (results.length > 0) {
          const txData = results[0]; // Get the transaction data from the result
          const tx = new Transaction(txData.from_address, txData.to_address, txData.amount, txData.timestamp, txData.signature, txData.block_hash);
          tx.hash = txData.hash; // Set the hash
          resolve(tx); // Resolve with the transaction object
        } else {
          resolve(null); // If no results found, resolve with null
        }
      });
    });
  }

  // Add Solana-specific transaction handling
  async executeSolanaTransaction(fromKeypair, toAddress) {
    try {
      const balance = await getBalance(fromKeypair.publicKey.toString());
      if (balance < this.amount) {
        throw new Error('Insufficient balance');
      }

      const signature = await transferSOL(fromKeypair, toAddress, this.amount);
      console.log('Transaction confirmed with signature:', signature);

      // Save the transaction to your blockchain
      await this.save();
    } catch (error) {
      console.error('Solana transaction failed:', error);
    }
  }
  
  async savePending() {
    const query = 'INSERT INTO pending_transactions (hash, from_address, to_address, amount, timestamp, signature) VALUES (?, ?, ?, ?, ?, ?)';
    const values = [this.calculateHash(), this.fromAddress, this.toAddress, this.amount, this.timestamp, this.signature];

    console.log(`Saving transaction with hash: ${values[0]}`);
    console.log(`Data to be saved: ${JSON.stringify({
      hash: values[0],
      fromAddress: values[1],
      toAddress: values[2],
      amount: values[3],
      timestamp: values[4],
      signature: values[5]
    })}`);

    return new Promise((resolve, reject) => {
      db.query(query, values, (err) => {
        if (err) {
          console.error('Error saving transaction:', err);
          reject(err);
        } else {
          console.log('Transaction saved successfully');
          resolve();
        }
      });
    });
  }

  // Load all pending transactions
  static async loadPendingTransactions() {
    console.log('Loading pending transactions from the database...');
    return new Promise((resolve, reject) => {
      const query = 'SELECT * FROM pending_transactions';

      db.query(query, (err, results) => {
        if (err) {
          console.error('Error loading pending transactions:', err);
          return reject(err);
        }
  
        console.log(`Retrieved ${results.length} pending transactions`);
        
        const transactions = results.map(txData => {
          const tx = new Transaction(txData.from_address, txData.to_address, txData.amount, txData.timestamp, txData.signature);
          tx.hash = txData.hash;
          return tx;
        });
  
        console.log('Loaded transactions:', transactions.map(tx => ({
          hash: tx.hash,
          fromAddress: tx.fromAddress,
          toAddress: tx.toAddress,
          amount: tx.amount,
          timestamp: tx.timestamp,
          signature: tx.signature
        })));
  
        resolve(transactions);
      });
    });
  }

  // Verify that the pending transactions are saved in the database
  static async verifyPendingTransactions() {
    return new Promise((resolve, reject) => {
      const query = 'SELECT * FROM pending_transactions';
      db.query(query, (err, results) => {
        if (err) return reject(err);
        const transactions = results.map(txData => {
          const tx = new Transaction(txData.from_address, txData.to_address, txData.amount, txData.timestamp, txData.signature);
          tx.hash = txData.hash; // Ensure hash is set here
          return tx;
        });
        console.log('Pending Transactions:', transactions);
        resolve(transactions);
      });
    });
  }
  // Save the transaction to Redis as pending
  async savePendingToRedis() {
    const transactionData = {
      fromAddress: this.fromAddress,
      toAddress: this.toAddress,
      amount: this.amount,
      timestamp: this.timestamp,
      signature: this.signature
    };

    await client.hSet('pending_transactions', this.hash, JSON.stringify(transactionData));
    console.log('Transaction saved to Redis:', this.hash);
  }

  // Load all pending transactions from Redis
  static async loadPendingTransactionsFromRedis() {
    const transactions = await client.hGetAll('pending_transactions');
    const transactionObjects = [];

    for (const [hash, data] of Object.entries(transactions)) {
      const txData = JSON.parse(data);
      const tx = new Transaction(txData.fromAddress, txData.toAddress, txData.amount, txData.timestamp, txData.signature);
      tx.hash = hash;
      transactionObjects.push(tx);
    }

    console.log('Loaded transactions from Redis:', transactionObjects);
    return transactionObjects;
  }

  // Remove a transaction from Redis
  static async removePendingTransactionFromRedis(hash) {
    await client.hDel('pending_transactions', hash);
    console.log('Transaction removed from Redis:', hash);
  }
}

class Block {
  constructor(index, previousHash, timestamp, transactions, difficulty) {
    this.index = index; // Block index in the blockchain
    this.previousHash = previousHash; // Hash of the previous block
    this.timestamp = timestamp; // Timestamp of when the block was created
    this.transactions = transactions; // Array of transactions in this block
    this.difficulty = difficulty; // Mining difficulty for this block
    this.merkleRoot = this.calculateMerkleRoot(); // Root hash of the Merkle tree
    this.nonce = 0; // Nonce for mining (initially set to 0)
    this.hash = this.calculateHash(); // Calculate the block hash
  }

  // Calculate the Merkle root for the transactions in the block
  calculateMerkleRoot() {
    if (this.transactions.length === 0) {
      return "0".repeat(64); // Return a default hash if there are no transactions
    }
    const hashes = this.transactions.map((tx) => tx.hash); // Get hashes of all transactions
    const merkleTree = new MerkleTree(hashes); // Create a Merkle tree with the transaction hashes
    return merkleTree.getRootHash(); // Get the root hash of the Merkle tree
  }

  // Calculate the hash of the block
  calculateHash() {
    const transactionsData = JSON.stringify(
      this.transactions.map((tx) => {
        const { blockHash, ...txWithoutBlockHash } = tx; // Exclude blockHash from transaction data
        return txWithoutBlockHash; // Convert transactions to JSON string
      })
    );

    return crypto
      .createHash("sha256")
      .update(
        this.previousHash +
          this.timestamp +
          this.merkleRoot +
          this.nonce +
          transactionsData
      )
      .digest("hex");
  }

  // Mine the block by finding a hash that meets the difficulty requirements
  mineBlock(difficulty) {
    while (
      this.hash.substring(0, difficulty) !== Array(difficulty + 1).join("0")
    ) {
      this.nonce++; // Increment the nonce
      this.hash = this.calculateHash(); // Recalculate the block hash
    }
  }

  // Check if all transactions in the block are valid
  hasValidTransactions() {
    for (const tx of this.transactions) {
      if (!tx.isValid()) {
        console.error(`Invalid transaction: ${tx.hash}`); // Log invalid transactions
        return false;
      }
    }
    return true; // All transactions are valid
  }

  // Save the block to the database
  async save() {
    const query =
      "INSERT INTO blocks (hash, previous_hash, timestamp, nonce, difficulty, merkle_root, `index`) VALUES (?, ?, ?, ?, ?, ?, ?)";
    const values = [
      this.hash,
      this.previousHash,
      this.timestamp,
      this.nonce,
      this.difficulty,
      this.merkleRoot,
      this.index,
    ];
    return new Promise((resolve, reject) => {
      db.query(query, values, async (err, results) => {
        if (err) {
          return reject(err);
        }
        try {
          for (const tx of this.transactions) {
            tx.blockHash = this.hash;
            await tx.save();
          }

          const merkleTree = new MerkleTree(
            this.transactions.map((tx) => tx.hash)
          );
          await merkleTree.saveNodesToDatabase(this.hash);

          // Store Merkle proofs
          for (const tx of this.transactions) {
            const proof = merkleTree.getProof(tx.hash);
            await this.saveMerkleProof(tx.hash, proof);
          }

          resolve(results);
        } catch (saveErr) {
          reject(saveErr);
        }
      });
    });
  }

  async saveMerkleProof(transactionHash, proof) {
    const query =
      "INSERT INTO merkle_proof_paths (block_hash, transaction_hash, proof_path) VALUES (?, ?, ?)";
    const values = [this.hash, transactionHash, JSON.stringify(proof)];
    return new Promise((resolve, reject) => {
      db.query(query, values, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  // Load a block from the database
  static async load(hash) {
    const query = "SELECT * FROM blocks WHERE hash = ?";
    return new Promise((resolve, reject) => {
      db.query(query, [hash], async (err, results) => {
        if (err) return reject(err); // If there is an error, reject the promise
        if (results.length > 0) {
          const result = results[0]; // Get the block data from the result
          const block = new Block(
            result.index,
            result.previous_hash,
            result.timestamp,
            [],
            result.difficulty
          );
          block.hash = result.hash; // Set the block hash
          block.nonce = result.nonce; // Set the nonce
          block.merkleRoot = result.merkle_root; // Set the Merkle root

          // Load transactions for the block
          const txQuery = "SELECT hash FROM transactions WHERE block_hash = ?";
          db.query(txQuery, [block.hash], async (err, txResults) => {
            if (err) return reject(err); // If there is an error, reject the promise
            for (const tx of txResults) {
              const transaction = await Transaction.loadFromRedis(tx.hash) || await Transaction.load(tx.hash); // Load each transaction
              if (transaction) {
                if (!transaction.isValid()) {
                  console.error(
                    `Invalid transaction in block ${block.index}: ${tx.hash}`
                  );
                  return reject(
                    new Error(`Invalid transaction in block ${block.index}`)
                  );
                }
                block.transactions.push(transaction); // Add valid transactions to the block
              }
            }
            // Validate the block's hash and Merkle root
            if (block.hash !== block.calculateHash()) {
              console.error(`Invalid block hash for block ${block.index}`);
              return reject(
                new Error(`Invalid block hash for block ${block.index}`)
              );
            }
            if (block.merkleRoot !== block.calculateMerkleRoot()) {
              console.error(`Invalid Merkle root for block ${block.index}`);
              return reject(
                new Error(`Invalid Merkle root for block ${block.index}`)
              );
            }
            resolve(block); // Resolve with the block object
          });
        } else {
          resolve(null); // If no results found, resolve with null
        }
      });
    });
  }
}

class Blockchain {
  constructor() {
    this.chain = []; // Start with the genesis block
    this.difficulty = 0; // Initial difficulty (for mining)
    this.pendingTransactions = []; // Transactions waiting to be mined
    this.miningReward = 100; // Reward for mining a new block
    this.transactionThreshold = 2; // Number of transactions required to mine a block
    this.minerAddress = "miner-address"; // Set your miner address here
    this.genesisAddress = "genesis-address"; 
    console.log("Blockchain initialized with transaction threshold:", this.transactionThreshold);

    // Initialize the blockchain with the genesis block
    this.initializeGenesisBlock();

  }

  // Create the first block of the blockchain (genesis block)
  initializeGenesisBlock() {
    console.log("Creating genesis block...");
    this.createGenesisBlockWithReward("genesis-address", 1000000); // Adjust address and reward as needed
  }

  // Create the genesis block with a reward transaction
  async createGenesisBlockWithReward(genesisAddress, initialReward) {
    const rewardTx = new Transaction(null, genesisAddress, initialReward); // Reward transaction
    rewardTx.hash = rewardTx.calculateHash();
    rewardTx.signature = null; // Reward transactions don't need a signature

    const genesisBlock = new Block(
      0,
      "0",
      Date.now(),
      [rewardTx], // Include reward transaction in the genesis block
      this.difficulty
    );
    genesisBlock.mineBlock(this.difficulty);

    this.chain.push(genesisBlock);

    await genesisBlock.save(); // Save the block to the database

    // Update the balance of the genesis address
    await this.updateWalletBalance(genesisAddress, initialReward);

    console.log(`Genesis block created with initial balance of ${initialReward} to address ${genesisAddress}`);
  }

  // Get the latest block in the blockchain
  getLatestBlock() {
    return this.chain[this.chain.length - 1];
  }

  async addInitialBalance(address, amount) {
    // Create an initial reward transaction
    const rewardTx = new Transaction(null, address, amount);
    rewardTx.hash = rewardTx.calculateHash();
    rewardTx.signature = null; // Reward transactions don't need a signature

    // Create a block with the reward transaction
    const block = new Block(
      this.chain.length,
      this.getLatestBlock().hash,
      Date.now(),
      [rewardTx],
      this.difficulty
    );
    block.mineBlock(this.difficulty);

    console.log(`Mined initial block with hash: ${block.hash}`);
    this.chain.push(block);

    await block.save(); // Save the block to the database
    console.log(`Initial balance of ${amount} credited to address ${address}`);
  }

  async addTransaction(transaction) {
    if (!transaction.fromAddress || !transaction.toAddress) {
        throw new Error("Transaction must include from and to address");
    }
    if (!transaction.isValid()) {
        throw new Error("Cannot add invalid transaction to chain");
    }
    if (transaction.amount <= 0) {
        throw new Error("Transaction amount must be greater than 0");
    }

    const balance = await this.getBalanceOfAddress(transaction.fromAddress);
    if (balance < transaction.amount) {
        throw new Error("Not enough balance");
    }

    await this.updateWalletBalance(transaction.fromAddress, -transaction.amount);
    await this.updateWalletBalance(transaction.toAddress, transaction.amount);

    await transaction.savePendingToRedis();
    this.pendingTransactions.push(transaction);
    console.log("Transaction added to pending transactions:", transaction.hash);
  }


  // Mine pending transactions and add a new block to the blockchain
  async minePendingTransactions(miningRewardAddress) {
    const lockAcquired = await acquireLock("miningLock", 10000);
    if (!lockAcquired) {
        console.log("Mining is already in progress.");
        return;
    }

    try {
        console.log("Mining pending transactions...");

        // Use Redis to get pending transactions
        this.pendingTransactions = await Transaction.loadPendingTransactionsFromRedis();

        const lastBlock = this.chain.length > 0 ? this.getLatestBlock() : null;
        const blockTransactions = this.pendingTransactions.slice(0, this.transactionThreshold);

        if (blockTransactions.length === 0) {
            console.log("No pending transactions to mine.");
            return;
        }

        const rewardTx = new Transaction(null, miningRewardAddress, this.miningReward);
        rewardTx.hash = rewardTx.calculateHash();
        blockTransactions.push(rewardTx);

        const block = new Block(
            lastBlock ? lastBlock.index + 1 : 0,
            lastBlock ? lastBlock.hash : "",
            Date.now(),
            blockTransactions,
            this.difficulty
        );

        block.mineBlock(this.difficulty);
        this.chain.push(block);

        await block.save();

        for (const tx of blockTransactions) {
            await Transaction.removePendingTransactionFromRedis(tx.hash);

            await this.updateWalletBalance(tx.fromAddress, -tx.amount);
            await this.updateWalletBalance(tx.toAddress, tx.amount);
        }

        console.log("Cleared mined transactions from Redis.");
    } catch (error) {
        console.error("Error during mining process:", error);
    } finally {
        await releaseLock("miningLock");
    }
  }

  getMinerAddress() {
    return this.minerAddress;
  }

  async updateWalletBalance(address, amount) {
    try {
        let currentBalance = await client.get(`wallet_balance_${address}`);
        currentBalance = currentBalance ? parseFloat(currentBalance) : 0;
        const newBalance = currentBalance + amount;

        await client.set(`wallet_balance_${address}`, newBalance);
        console.log(`Updated balance for ${address}: ${newBalance}`);
    } catch (error) {
        console.error(`Error updating balance for ${address}:`, error);
    }
  }

  async getBalanceOfAddress(address) {
    try {
        const balance = await client.get(`wallet_balance_${address}`);
        return balance ? parseFloat(balance) : 0;
    } catch (error) {
        console.error(`Error retrieving balance for ${address}:`, error);
        return 0; // Return 0 if there is an error
    }
  } 

  async displayBalance(address) {
    try {
        const balance = await this.getBalanceOfAddress(address);
        console.log(`Balance of ${address}: ${balance}`);
    } catch (error) {
        console.error(`Error displaying balance for ${address}:`, error);
    }
  }


  // Check if the blockchain is valid
  isChainValid() {
    for (let i = 1; i < this.chain.length; i++) {
      const currentBlock = this.chain[i];
      const previousBlock = this.chain[i - 1];

      // Check if the current block's hash is valid
      if (currentBlock.hash !== currentBlock.calculateHash()) {
        console.error(`Invalid hash at block ${currentBlock.index}`);
        return false;
      }

      // Check if the previous hash matches the previous block's hash
      if (currentBlock.previousHash !== previousBlock.hash) {
        console.error(`Invalid previous hash at block ${currentBlock.index}`);
        return false;
      }

      // Check if the Merkle root is valid
      const calculatedMerkleRoot = currentBlock.calculateMerkleRoot();
      if (currentBlock.merkleRoot !== calculatedMerkleRoot) {
        console.error(`Invalid Merkle root in block ${currentBlock.index}`);
        console.error(`Stored Merkle root: ${currentBlock.merkleRoot}`);
        console.error(`Calculated Merkle root: ${calculatedMerkleRoot}`);
        return false;
      }
    }
    return true; // Blockchain is valid
  }

  // Load the blockchain from the database
  static async load() {
    const blockchain = new Blockchain();
    const query = "SELECT * FROM blocks ORDER BY index ASC";
    return new Promise((resolve, reject) => {
      db.query(query, async (err, results) => {
        if (err) return reject(err); // If there is an error, reject the promise
        for (const result of results) {
          const block = await Block.load(result.hash); // Load each block
          if (block) {
            blockchain.chain.push(block); // Add the block to the blockchain
          }
        }

        // Validate the blockchain after loading
        if (!blockchain.isChainValid()) {
          console.error("Blockchain is invalid");
          reject(new Error("Blockchain is invalid"));
        } else {
          console.log("Blockchain is valid");
          resolve(blockchain); // Resolve with the loaded blockchain
        }
      });
    });
  }

  async countPendingTransactions() {
    return new Promise((resolve, reject) => {
      const query = "SELECT COUNT(*) AS count FROM pending_transactions"; // SQL query to count pending transactions
      db.query(query, (err, results) => {
        if (err) return reject(err); // Reject promise if there's an error
        resolve(results[0].count); // Resolve promise with the count of pending transactions
      });
    });
  }

  // Clear pending transactions from the database
  async clearPendingTransactions() {
    return new Promise((resolve, reject) => {
      const query = "DELETE FROM pending_transactions"; // SQL query to delete pending transactions
      db.query(query, (err, results) => {
        if (err) return reject(err); // Reject promise if there's an error
        resolve(results); // Resolve promise with the result of the deletion
      });
    });
  }
  
}

// Check pending transactions
if (require.main === module) {
  (async function checkPendingTransactions() {
    const blockchain = new Blockchain();
    try {
      const count = await blockchain.countPendingTransactions();
      console.log(`There are ${count} pending transactions.`);
    } catch (error) {
      console.error('Error counting pending transactions:', error);
    }
  })();
}


module.exports = {
  Blockchain,
  Transaction,
  Block
};

