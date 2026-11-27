import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type {
  MetaPayGateway,
  MetaPaySwapRouter,
  MockERC20,
  WMEC,
} from "../typechain-types";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("MetaPayGateway", function () {
  const FAUCET_USDT = ethers.parseUnits("1000", 6);
  const FAUCET_USDC = ethers.parseUnits("1000", 6);
  const FAUCET_IDRC = ethers.parseUnits("10000000", 2);
  const PRICE_USD_1 = ethers.parseUnits("1", 18);
  const PRICE_MEC = ethers.parseUnits("0.5", 18); // 1 MEC = $0.50
  const PRICE_IDRC = ethers.parseUnits("0.0000625", 18); // 1 USD = 16,000 IDRC

  let owner: HardhatEthersSigner;
  let merchantCreator: HardhatEthersSigner;
  let specifiedRecipient: HardhatEthersSigner;
  let payer: HardhatEthersSigner;
  let splitA: HardhatEthersSigner;
  let splitB: HardhatEthersSigner;
  let splitC: HardhatEthersSigner;

  let wmec: WMEC;
  let mUSDT: MockERC20;
  let mUSDC: MockERC20;
  let idrc: MockERC20;
  let router: MetaPaySwapRouter;
  let gateway: MetaPayGateway;

  beforeEach(async function () {
    [
      owner,
      merchantCreator,
      specifiedRecipient,
      payer,
      splitA,
      splitB,
      splitC,
    ] = await ethers.getSigners();

    const WMECFactory = await ethers.getContractFactory("WMEC");
    wmec = await WMECFactory.deploy();
    await wmec.waitForDeployment();

    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    mUSDT = await MockERC20Factory.deploy(
      "Meta USDT",
      "mUSDT",
      6,
      FAUCET_USDT,
      owner.address
    );
    await mUSDT.waitForDeployment();

    mUSDC = await MockERC20Factory.deploy(
      "Meta USDC",
      "mUSDC",
      6,
      FAUCET_USDC,
      owner.address
    );
    await mUSDC.waitForDeployment();

    idrc = await MockERC20Factory.deploy(
      "Indonesian Rupiah Coin",
      "IDRC",
      2,
      FAUCET_IDRC,
      owner.address
    );
    await idrc.waitForDeployment();

    const RouterFactory = await ethers.getContractFactory("MetaPaySwapRouter");
    router = await RouterFactory.deploy(owner.address);
    await router.waitForDeployment();

    await router.setTokenPrice(await mUSDT.getAddress(), PRICE_USD_1, 6);
    await router.setTokenPrice(await mUSDC.getAddress(), PRICE_USD_1, 6);
    await router.setTokenPrice(await wmec.getAddress(), PRICE_MEC, 18);
    await router.setTokenPrice(await idrc.getAddress(), PRICE_IDRC, 2);

    // Seed router liquidity
    await mUSDT.mint(await router.getAddress(), ethers.parseUnits("1000000", 6));
    await mUSDC.mint(await router.getAddress(), ethers.parseUnits("1000000", 6));
    await idrc.mint(await router.getAddress(), ethers.parseUnits("10000000000", 2));
    await wmec.deposit({ value: ethers.parseEther("500") });
    await wmec.transfer(await router.getAddress(), ethers.parseEther("500"));

    const GatewayFactory = await ethers.getContractFactory("MetaPayGateway");
    gateway = await GatewayFactory.deploy(
      await router.getAddress(),
      await wmec.getAddress(),
      owner.address
    );
    await gateway.waitForDeployment();

    // Give payer some test tokens via faucet
    await mUSDT.connect(payer).faucet();
    await mUSDC.connect(payer).faucet();
    await idrc.connect(payer).faucet();
  });

  function makeId(label: string): string {
    return ethers.keccak256(ethers.toUtf8Bytes(label));
  }

  it("1. MockERC20 faucet mints expected amount", async function () {
    expect(await mUSDT.balanceOf(payer.address)).to.equal(FAUCET_USDT);
    expect(await mUSDC.balanceOf(payer.address)).to.equal(FAUCET_USDC);

    await expect(mUSDT.connect(splitA).faucet())
      .to.emit(mUSDT, "FaucetClaimed")
      .withArgs(splitA.address, FAUCET_USDT);
    expect(await mUSDT.balanceOf(splitA.address)).to.equal(FAUCET_USDT);
  });

  it("2. Same-token invoice payment (ERC-20 and Native MEC with excess refund)", async function () {
    const gatewayAddr = await gateway.getAddress();
    const usdtAddr = await mUSDT.getAddress();

    // 2a. ERC-20 same token
    const invId1 = makeId("same-erc20");
    const target1 = ethers.parseUnits("50", 6);
    await gateway
      .connect(merchantCreator)
      .createInvoice(invId1, specifiedRecipient.address, usdtAddr, target1, 0, []);

    await mUSDT.connect(payer).approve(gatewayAddr, target1);
    const beforeUsdt = await mUSDT.balanceOf(specifiedRecipient.address);

    await expect(
      gateway.connect(payer).payInvoice(invId1, usdtAddr, target1)
    ).to.emit(gateway, "PaymentSettled");

    expect(await mUSDT.balanceOf(specifiedRecipient.address)).to.equal(
      beforeUsdt + target1
    );

    // 2b. Native MEC same token with excess refund
    const invId2 = makeId("same-native");
    const target2 = ethers.parseEther("5");
    await gateway
      .connect(merchantCreator)
      .createInvoice(
        invId2,
        specifiedRecipient.address,
        ethers.ZeroAddress,
        target2,
        0,
        []
      );

    const recipientBefore = await ethers.provider.getBalance(
      specifiedRecipient.address
    );
    const payerBefore = await ethers.provider.getBalance(payer.address);

    const tx = await gateway
      .connect(payer)
      .payInvoice(invId2, ethers.ZeroAddress, target2, {
        value: ethers.parseEther("8"), // 3 MEC excess
      });
    const receipt = await tx.wait();
    const gasCost = receipt!.gasUsed * receipt!.gasPrice;

    expect(await ethers.provider.getBalance(specifiedRecipient.address)).to.equal(
      recipientBefore + target2
    );
    expect(await ethers.provider.getBalance(payer.address)).to.equal(
      payerBefore - target2 - gasCost
    );
  });

  it("3. Cross-token invoice payment: mUSDC -> mUSDT, Native MEC -> mUSDT, mUSDT -> Native MEC", async function () {
    const gatewayAddr = await gateway.getAddress();
    const usdtAddr = await mUSDT.getAddress();
    const usdcAddr = await mUSDC.getAddress();

    // 3a. mUSDC -> mUSDT
    const inv1 = makeId("cross-usdc-usdt");
    const targetUsdt = ethers.parseUnits("100", 6);
    await gateway
      .connect(merchantCreator)
      .createInvoice(inv1, specifiedRecipient.address, usdtAddr, targetUsdt, 0, []);

    const quoteUsdc = await gateway.quotePayment(usdcAddr, usdtAddr, targetUsdt);
    expect(quoteUsdc).to.be.gt(targetUsdt); // includes 0.3% swap fee

    await mUSDC.connect(payer).approve(gatewayAddr, quoteUsdc);
    const recBefore1 = await mUSDT.balanceOf(specifiedRecipient.address);
    await gateway.connect(payer).payInvoice(inv1, usdcAddr, quoteUsdc);
    expect(await mUSDT.balanceOf(specifiedRecipient.address)).to.equal(
      recBefore1 + targetUsdt
    );

    // 3b. Native MEC -> mUSDT (with excess native refund)
    const inv2 = makeId("cross-mec-usdt");
    const targetUsdt2 = ethers.parseUnits("25", 6);
    await gateway
      .connect(merchantCreator)
      .createInvoice(inv2, specifiedRecipient.address, usdtAddr, targetUsdt2, 0, []);

    const quoteMec = await gateway.quotePayment(
      ethers.ZeroAddress,
      usdtAddr,
      targetUsdt2
    );
    // 25 USD at $0.50/MEC = 50 MEC + 0.3% fee
    expect(quoteMec).to.be.gt(ethers.parseEther("50"));

    const recBefore2 = await mUSDT.balanceOf(specifiedRecipient.address);
    const payerBalBefore = await ethers.provider.getBalance(payer.address);
    const tx2 = await gateway
      .connect(payer)
      .payInvoice(inv2, ethers.ZeroAddress, quoteMec, {
        value: quoteMec + ethers.parseEther("2"),
      });
    const r2 = await tx2.wait();
    const gas2 = r2!.gasUsed * r2!.gasPrice;

    expect(await mUSDT.balanceOf(specifiedRecipient.address)).to.equal(
      recBefore2 + targetUsdt2
    );
    expect(await ethers.provider.getBalance(payer.address)).to.equal(
      payerBalBefore - quoteMec - gas2
    );

    // 3c. mUSDT -> Native MEC
    const inv3 = makeId("cross-usdt-mec");
    const targetMec = ethers.parseEther("10"); // $5 worth of MEC
    await gateway
      .connect(merchantCreator)
      .createInvoice(
        inv3,
        specifiedRecipient.address,
        ethers.ZeroAddress,
        targetMec,
        0,
        []
      );

    const quoteUsdt = await gateway.quotePayment(
      usdtAddr,
      ethers.ZeroAddress,
      targetMec
    );
    await mUSDT.connect(payer).approve(gatewayAddr, quoteUsdt);
    const recMecBefore = await ethers.provider.getBalance(
      specifiedRecipient.address
    );
    await gateway.connect(payer).payInvoice(inv3, usdtAddr, quoteUsdt);
    expect(await ethers.provider.getBalance(specifiedRecipient.address)).to.equal(
      recMecBefore + targetMec
    );
  });

  it("4. Specified address payment routes funds to recipient != creator", async function () {
    const usdtAddr = await mUSDT.getAddress();
    const invId = makeId("specified-recipient");
    const amount = ethers.parseUnits("42", 6);

    await gateway
      .connect(merchantCreator)
      .createInvoice(invId, specifiedRecipient.address, usdtAddr, amount, 0, []);

    const creatorBefore = await mUSDT.balanceOf(merchantCreator.address);
    const recipientBefore = await mUSDT.balanceOf(specifiedRecipient.address);

    await mUSDT.connect(payer).approve(await gateway.getAddress(), amount);
    await gateway.connect(payer).payInvoice(invId, usdtAddr, amount);

    expect(await mUSDT.balanceOf(merchantCreator.address)).to.equal(creatorBefore);
    expect(await mUSDT.balanceOf(specifiedRecipient.address)).to.equal(
      recipientBefore + amount
    );
  });

  it("5. Multi-recipient payment splitting and odd-amount dust handling", async function () {
    const usdtAddr = await mUSDT.getAddress();
    const gatewayAddr = await gateway.getAddress();

    // 5a. Standard split 50% / 30% / 20%
    const invId1 = makeId("split-standard");
    const amount1 = ethers.parseUnits("100", 6);
    const splits1 = [
      { recipient: splitA.address, bps: 5000 },
      { recipient: splitB.address, bps: 3000 },
      { recipient: splitC.address, bps: 2000 },
    ];

    await gateway
      .connect(merchantCreator)
      .createInvoice(invId1, specifiedRecipient.address, usdtAddr, amount1, 0, splits1);

    await mUSDT.connect(payer).approve(gatewayAddr, amount1);
    await expect(gateway.connect(payer).payInvoice(invId1, usdtAddr, amount1))
      .to.emit(gateway, "SplitDistributed")
      .withArgs(invId1, splitA.address, usdtAddr, ethers.parseUnits("50", 6));

    expect(await mUSDT.balanceOf(splitA.address)).to.equal(
      ethers.parseUnits("50", 6)
    );
    expect(await mUSDT.balanceOf(splitB.address)).to.equal(
      ethers.parseUnits("30", 6)
    );
    expect(await mUSDT.balanceOf(splitC.address)).to.equal(
      ethers.parseUnits("20", 6)
    );

    // 5b. Odd amount dust check: 100 wei split 3333 / 3333 / 3334 -> 33 / 33 / 34
    const invId2 = makeId("split-dust");
    const amount2 = 100n;
    const splits2 = [
      { recipient: splitA.address, bps: 3333 },
      { recipient: splitB.address, bps: 3333 },
      { recipient: splitC.address, bps: 3334 },
    ];
    const aBefore = await mUSDT.balanceOf(splitA.address);
    const bBefore = await mUSDT.balanceOf(splitB.address);
    const cBefore = await mUSDT.balanceOf(splitC.address);

    await gateway
      .connect(merchantCreator)
      .createInvoice(invId2, specifiedRecipient.address, usdtAddr, amount2, 0, splits2);
    await mUSDT.connect(payer).approve(gatewayAddr, amount2);
    await gateway.connect(payer).payInvoice(invId2, usdtAddr, amount2);

    expect(await mUSDT.balanceOf(splitA.address)).to.equal(aBefore + 33n);
    expect(await mUSDT.balanceOf(splitB.address)).to.equal(bBefore + 33n);
    expect(await mUSDT.balanceOf(splitC.address)).to.equal(cBefore + 34n);

    // 5c. Invalid split bps sum reverts
    const badSplits = [
      { recipient: splitA.address, bps: 5000 },
      { recipient: splitB.address, bps: 4000 },
    ];
    await expect(
      gateway
        .connect(merchantCreator)
        .createInvoice(
          makeId("split-bad"),
          specifiedRecipient.address,
          usdtAddr,
          amount1,
          0,
          badSplits
        )
    ).to.be.revertedWithCustomError(gateway, "InvalidSplitBps");
  });

  it("6. Time-Fixed invoice succeeds before deadline and reverts after expiry", async function () {
    const usdtAddr = await mUSDT.getAddress();
    const gatewayAddr = await gateway.getAddress();
    const now = await time.latest();
    const amount = ethers.parseUnits("10", 6);

    // 6a. Succeeds before expiry
    const invValid = makeId("time-fixed-valid");
    await gateway
      .connect(merchantCreator)
      .createInvoice(
        invValid,
        specifiedRecipient.address,
        usdtAddr,
        amount,
        now + 300,
        []
      );
    await mUSDT.connect(payer).approve(gatewayAddr, amount);
    await gateway.connect(payer).payInvoice(invValid, usdtAddr, amount);

    // 6b. Reverts after expiry
    const invExpired = makeId("time-fixed-expired");
    const deadline = (await time.latest()) + 60;
    await gateway
      .connect(merchantCreator)
      .createInvoice(
        invExpired,
        specifiedRecipient.address,
        usdtAddr,
        amount,
        deadline,
        []
      );

    await time.increaseTo(deadline + 1);
    await mUSDT.connect(payer).approve(gatewayAddr, amount);
    await expect(
      gateway.connect(payer).payInvoice(invExpired, usdtAddr, amount)
    ).to.be.revertedWithCustomError(gateway, "InvoiceExpired");
  });

  it("7. No-Limit invoice (expiresAt == 0) remains payable after 1 year", async function () {
    const usdtAddr = await mUSDT.getAddress();
    const gatewayAddr = await gateway.getAddress();
    const invId = makeId("no-limit");
    const amount = ethers.parseUnits("15", 6);

    await gateway
      .connect(merchantCreator)
      .createInvoice(invId, specifiedRecipient.address, usdtAddr, amount, 0, []);

    await time.increase(365 * 24 * 3600);

    await mUSDT.connect(payer).approve(gatewayAddr, amount);
    await expect(
      gateway.connect(payer).payInvoice(invId, usdtAddr, amount)
    ).to.emit(gateway, "PaymentSettled");
  });

  it("8. Invoice cancellation by creator, unauthorized revert, and paying cancelled revert", async function () {
    const usdtAddr = await mUSDT.getAddress();
    const invId = makeId("cancel-test");
    const amount = ethers.parseUnits("20", 6);

    await gateway
      .connect(merchantCreator)
      .createInvoice(invId, specifiedRecipient.address, usdtAddr, amount, 0, []);

    await expect(
      gateway.connect(payer).cancelInvoice(invId)
    ).to.be.revertedWithCustomError(gateway, "Unauthorized");

    await expect(gateway.connect(merchantCreator).cancelInvoice(invId))
      .to.emit(gateway, "InvoiceCancelled")
      .withArgs(invId, merchantCreator.address);

    await mUSDT.connect(payer).approve(await gateway.getAddress(), amount);
    await expect(
      gateway.connect(payer).payInvoice(invId, usdtAddr, amount)
    ).to.be.revertedWithCustomError(gateway, "InvoiceAlreadyCancelled");
  });

  it("9. payDirect (HTTP 402 flow) supports cross-token + splits and prevents replay", async function () {
    const usdtAddr = await mUSDT.getAddress();
    const usdcAddr = await mUSDC.getAddress();
    const gatewayAddr = await gateway.getAddress();

    const refId = makeId("http-402-req-1");
    const targetAmount = ethers.parseUnits("10", 6);
    const deadline = (await time.latest()) + 300;
    const splits = [
      { recipient: splitA.address, bps: 8000 },
      { recipient: splitB.address, bps: 2000 },
    ];

    const quoteUsdc = await gateway.quotePayment(usdcAddr, usdtAddr, targetAmount);
    await mUSDC.connect(payer).approve(gatewayAddr, quoteUsdc * 2n);

    await expect(
      gateway
        .connect(payer)
        .payDirect(
          refId,
          specifiedRecipient.address,
          usdtAddr,
          targetAmount,
          deadline,
          splits,
          usdcAddr,
          quoteUsdc
        )
    ).to.emit(gateway, "PaymentSettled");

    expect(await gateway.settledPayments(refId)).to.equal(true);
    expect(await mUSDT.balanceOf(splitA.address)).to.equal(
      ethers.parseUnits("8", 6)
    );
    expect(await mUSDT.balanceOf(splitB.address)).to.equal(
      ethers.parseUnits("2", 6)
    );

    // Replay with same refId must revert
    await expect(
      gateway
        .connect(payer)
        .payDirect(
          refId,
          specifiedRecipient.address,
          usdtAddr,
          targetAmount,
          deadline,
          splits,
          usdcAddr,
          quoteUsdc
        )
    ).to.be.revertedWithCustomError(gateway, "PaymentAlreadySettled");

    // Expired payDirect must revert
    const expiredRef = makeId("http-402-expired");
    await expect(
      gateway
        .connect(payer)
        .payDirect(
          expiredRef,
          specifiedRecipient.address,
          usdtAddr,
          targetAmount,
          deadline - 400,
          [],
          usdcAddr,
          quoteUsdc
        )
    ).to.be.revertedWithCustomError(gateway, "InvoiceExpired");
  });

  it("10. Slippage protection reverts if maxPayAmount is lower than quote", async function () {
    const usdtAddr = await mUSDT.getAddress();
    const usdcAddr = await mUSDC.getAddress();
    const gatewayAddr = await gateway.getAddress();

    const invId = makeId("slippage-test");
    const targetAmount = ethers.parseUnits("50", 6);
    await gateway
      .connect(merchantCreator)
      .createInvoice(invId, specifiedRecipient.address, usdtAddr, targetAmount, 0, []);

    const quote = await gateway.quotePayment(usdcAddr, usdtAddr, targetAmount);
    await mUSDC.connect(payer).approve(gatewayAddr, quote);

    await expect(
      gateway.connect(payer).payInvoice(invId, usdcAddr, quote - 1n)
    ).to.be.revertedWithCustomError(gateway, "SlippageExceeded");
  });

  it("11. Cross-token payment with IDRC (IDRC -> mUSDT and mUSDT -> IDRC)", async function () {
    const gatewayAddr = await gateway.getAddress();
    const usdtAddr = await mUSDT.getAddress();
    const idrcAddr = await idrc.getAddress();

    // 11a. IDRC -> mUSDT (merchant receives exact 10 mUSDT)
    const invId1 = makeId("cross-idrc-usdt");
    const targetUsdt = ethers.parseUnits("10", 6);
    await gateway
      .connect(merchantCreator)
      .createInvoice(invId1, specifiedRecipient.address, usdtAddr, targetUsdt, 0, []);

    const quoteIdrc = await gateway.quotePayment(idrcAddr, usdtAddr, targetUsdt);
    // 10 USD * 16,000 = 160,000 IDRC + 0.3% fee
    expect(quoteIdrc).to.be.gt(ethers.parseUnits("160000", 2));

    await idrc.connect(payer).approve(gatewayAddr, quoteIdrc);
    const recUsdtBefore = await mUSDT.balanceOf(specifiedRecipient.address);
    await gateway.connect(payer).payInvoice(invId1, idrcAddr, quoteIdrc);
    expect(await mUSDT.balanceOf(specifiedRecipient.address)).to.equal(
      recUsdtBefore + targetUsdt
    );

    // 11b. mUSDT -> IDRC (merchant receives exact 160,000 IDRC)
    const invId2 = makeId("cross-usdt-idrc");
    const targetIdrc = ethers.parseUnits("160000", 2);
    await gateway
      .connect(merchantCreator)
      .createInvoice(invId2, specifiedRecipient.address, idrcAddr, targetIdrc, 0, []);

    const quoteUsdt = await gateway.quotePayment(usdtAddr, idrcAddr, targetIdrc);
    expect(quoteUsdt).to.be.gt(ethers.parseUnits("10", 6));

    await mUSDT.connect(payer).approve(gatewayAddr, quoteUsdt);
    const recIdrcBefore = await idrc.balanceOf(specifiedRecipient.address);
    await gateway.connect(payer).payInvoice(invId2, usdtAddr, quoteUsdt);
    expect(await idrc.balanceOf(specifiedRecipient.address)).to.equal(
      recIdrcBefore + targetIdrc
    );
  });
});
