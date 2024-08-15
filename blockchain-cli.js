const readline = require("readline");
const { Blockchain, Transaction } = require("./src/blockchain");
const { createNewWallet, loadWallet, ec } = require("./src/wallet");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

let blockchain;

async function askQuestion(query) {
  return new Promise((resolve) => rl.question(query, resolve));
}

async function main() {
  console.log("Blockchain CLI is starting...");

  // Initialize the blockchain and create the genesis block
  blockchain = new Blockchain();

  while (true) {
    console.log(`
    1. Create a new wallet
    2. Send a transaction
    3. View blockchain
    4. Add balance to address
    5. Check balance of address
    6. Exit
    `);

    const choice = await askQuestion("Select an option: ");

    switch (choice) {
      case "1":
        createNewWallet();
        break;
      case "2":
        await sendTransaction();
        break;
      case "3":
        await viewBlockchain();
        break;
      case "4":
        await addBalance();
        break;
      case "5":
        await checkBalance();
        break;
      case "6":
        console.log("Exiting...");
        rl.close();
        return;
      default:
        console.log("Invalid option. Please try again.");
    }
  }
}

async function sendTransaction() {
  try {
    const fromAddress = await askQuestion("Enter your wallet address: ");
    const privateKey = await askQuestion("Enter your private key: ");

    if (!privateKey || privateKey.length !== 64) {
      console.log("Invalid private key.");
      return;
    }

    const toAddress = await askQuestion("Enter the recipient address: ");
    const amount = parseFloat(await askQuestion("Enter the amount to send: "));

    if (isNaN(amount) || amount <= 0) {
      console.log("Invalid amount.");
      return;
    }

    // Create and sign transaction
    const tx = new Transaction(fromAddress, toAddress, amount);
    tx.sign(ec.keyFromPrivate(privateKey));

    console.log("Transaction details:", tx);

    // Save transaction and check threshold
    await tx.savePendingToRedis();
    console.log("Transaction saved as pending successfully.");

    const pendingTransactions = await Transaction.loadPendingTransactionsFromRedis();
    console.log("Pending transactions count:", pendingTransactions.length);

    // Mine a new block if threshold is reached
    if (pendingTransactions.length >= blockchain.transactionThreshold) {
      console.log(
        `Transaction threshold of ${blockchain.transactionThreshold} reached. Mining a new block...`
      );
      await blockchain.minePendingTransactions(blockchain.minerAddress);
      console.log("Mining complete.");
    } else {
      console.log(
        `Threshold not reached. Pending count: ${pendingTransactions.length}`
      );
    }
  } catch (error) {
    console.error("Error in sendTransaction:", error);
  }
}


async function viewBlockchain() {
  const blocks = blockchain.chain;
  console.log(`Total blocks: ${blocks.length}`);
  blocks.forEach((block) => {
    console.log(
      `Block ${block.index}: ${block.transactions.length} transactions`
    );
  });
}

async function addBalance() {
  const address = await askQuestion("Enter the address to credit: ");
  const amount = parseFloat(await askQuestion("Enter the amount to add: "));

  if (isNaN(amount) || amount <= 0) {
    console.log("Invalid amount.");
    return;
  }

  if (!address || address.length < 1) {
    console.log("Invalid address.");
    return;
  }

  await blockchain.updateWalletBalance(address, amount);
  console.log(`Successfully added ${amount} to address ${address}`);
}

async function checkBalance() {
  const address = await askQuestion("Enter the address to check balance: ");

  if (!address || address.length < 1) {
    console.log("Invalid address.");
    return;
  }

  try {
    const balance = await blockchain.getBalanceOfAddress(address);
    console.log(`Balance of address ${address}: ${balance}`);
  } catch (error) {
    console.error("Error fetching balance:", error);
  }
}

main().catch(console.error);


