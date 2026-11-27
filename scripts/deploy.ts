import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  const balance = await ethers.provider.getBalance(deployer.address);

  console.log("Deploying MetaPay contracts...");
  console.log(`Network: ${network.name} (chainId: ${chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance: ${ethers.formatEther(balance)} MEC`);

  // 1. Deploy WMEC
  const WMEC = await ethers.getContractFactory("WMEC");
  const wmec = await WMEC.deploy();
  await wmec.waitForDeployment();
  const wmecAddr = await wmec.getAddress();
  console.log(`WMEC deployed: ${wmecAddr}`);

  // 2. Deploy Mock Tokens (mUSDT, mUSDC)
  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const mUSDT = await MockERC20.deploy(
    "Meta USDT",
    "mUSDT",
    6,
    ethers.parseUnits("1000", 6),
    deployer.address
  );
  await mUSDT.waitForDeployment();
  const mUSDTAddr = await mUSDT.getAddress();
  console.log(`mUSDT deployed: ${mUSDTAddr}`);

  const mUSDC = await MockERC20.deploy(
    "Meta USDC",
    "mUSDC",
    6,
    ethers.parseUnits("1000", 6),
    deployer.address
  );
  await mUSDC.waitForDeployment();
  const mUSDCAddr = await mUSDC.getAddress();
  console.log(`mUSDC deployed: ${mUSDCAddr}`);

  const idrc = await MockERC20.deploy(
    "Indonesian Rupiah Coin",
    "IDRC",
    2,
    ethers.parseUnits("10000000", 2),
    deployer.address
  );
  await idrc.waitForDeployment();
  const idrcAddr = await idrc.getAddress();
  console.log(`IDRC deployed: ${idrcAddr}`);

  // 3. Deploy MetaPaySwapRouter
  const MetaPaySwapRouter = await ethers.getContractFactory("MetaPaySwapRouter");
  const router = await MetaPaySwapRouter.deploy(deployer.address);
  await router.waitForDeployment();
  const routerAddr = await router.getAddress();
  console.log(`MetaPaySwapRouter deployed: ${routerAddr}`);

  // Configure initial prices (1e18 USD scale)
  await (await router.setTokenPrice(mUSDTAddr, ethers.parseUnits("1", 18), 6)).wait();
  await (await router.setTokenPrice(mUSDCAddr, ethers.parseUnits("1", 18), 6)).wait();
  await (await router.setTokenPrice(wmecAddr, ethers.parseUnits("0.5", 18), 18)).wait();
  await (await router.setTokenPrice(idrcAddr, ethers.parseUnits("0.0000625", 18), 2)).wait();
  console.log(
    "Router token prices configured (mUSDT=$1, mUSDC=$1, WMEC=$0.50, IDRC=$0.0000625)"
  );

  // Seed MockERC20 liquidity into router
  const seedAmountStable = ethers.parseUnits("1000000", 6);
  const seedAmountIdrc = ethers.parseUnits("10000000000", 2);
  await (await mUSDT.mint(routerAddr, seedAmountStable)).wait();
  await (await mUSDC.mint(routerAddr, seedAmountStable)).wait();
  await (await idrc.mint(routerAddr, seedAmountIdrc)).wait();
  console.log(
    "Seeded 1,000,000 mUSDT, 1,000,000 mUSDC, and 10,000,000,000 IDRC into router"
  );

  // Seed WMEC liquidity safely based on deployer native MEC balance
  const currentBalance = await ethers.provider.getBalance(deployer.address);
  let wmecSeed = 0n;
  if (currentBalance > ethers.parseEther("15")) {
    wmecSeed = ethers.parseEther("10");
  } else if (currentBalance > ethers.parseEther("1")) {
    wmecSeed = ethers.parseEther("0.5");
  }

  if (wmecSeed > 0n) {
    await (await wmec.deposit({ value: wmecSeed })).wait();
    await (await wmec.transfer(routerAddr, wmecSeed)).wait();
    console.log(`Seeded ${ethers.formatEther(wmecSeed)} WMEC into router`);
  } else {
    console.warn(
      `WARNING: Skipping WMEC liquidity seeding (deployer balance ${ethers.formatEther(
        currentBalance
      )} MEC is too low). Fund WMEC and transfer to ${routerAddr} manually later.`
    );
  }

  // 4. Deploy MetaPayGateway
  const MetaPayGateway = await ethers.getContractFactory("MetaPayGateway");
  const gateway = await MetaPayGateway.deploy(
    routerAddr,
    wmecAddr,
    deployer.address
  );
  await gateway.waitForDeployment();
  const gatewayAddr = await gateway.getAddress();
  console.log(`MetaPayGateway deployed: ${gatewayAddr}`);

  // Save deployment artifact
  const deploymentsDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(deploymentsDir, { recursive: true });

  const deploymentInfo = {
    network: network.name,
    chainId,
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    contracts: {
      MetaPayGateway: gatewayAddr,
      MetaPaySwapRouter: routerAddr,
      WMEC: wmecAddr,
      mUSDT: mUSDTAddr,
      mUSDC: mUSDCAddr,
      IDRC: idrcAddr,
    },
    tokens: {
      MEC: {
        symbol: "MEC",
        address: ethers.ZeroAddress,
        decimals: 18,
        isNative: true,
      },
      WMEC: {
        symbol: "WMEC",
        address: wmecAddr,
        decimals: 18,
        isNative: false,
      },
      mUSDT: {
        symbol: "mUSDT",
        address: mUSDTAddr,
        decimals: 6,
        isNative: false,
      },
      mUSDC: {
        symbol: "mUSDC",
        address: mUSDCAddr,
        decimals: 6,
        isNative: false,
      },
      IDRC: {
        symbol: "IDRC",
        address: idrcAddr,
        decimals: 2,
        isNative: false,
      },
    },
  };

  const outFile = path.join(deploymentsDir, `${network.name}.json`);
  fs.writeFileSync(outFile, JSON.stringify(deploymentInfo, null, 2));
  console.log(`Saved deployment info to ${outFile}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
