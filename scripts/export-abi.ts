import * as fs from "fs";
import * as path from "path";

const CONTRACTS = [
  { name: "MetaPayGateway", artifactPath: "contracts/MetaPayGateway.sol/MetaPayGateway.json" },
  { name: "MetaPaySwapRouter", artifactPath: "contracts/swap/MetaPaySwapRouter.sol/MetaPaySwapRouter.json" },
  { name: "MockERC20", artifactPath: "contracts/tokens/MockERC20.sol/MockERC20.json" },
  { name: "WMEC", artifactPath: "contracts/tokens/WMEC.sol/WMEC.json" },
];

function main() {
  const rootDir = path.join(__dirname, "..");
  const artifactsDir = path.join(rootDir, "artifacts");
  const exportsDir = path.join(rootDir, "exports");
  fs.mkdirSync(exportsDir, { recursive: true });

  const abis: Record<string, unknown> = {};

  for (const c of CONTRACTS) {
    const fullPath = path.join(artifactsDir, c.artifactPath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Artifact not found at ${fullPath}. Run "npm run compile" first.`);
    }
    const raw = JSON.parse(fs.readFileSync(fullPath, "utf8"));
    abis[c.name] = raw.abi;
  }

  const outFile = path.join(exportsDir, "abis.json");
  fs.writeFileSync(outFile, JSON.stringify(abis, null, 2));
  console.log(`Exported ABIs for ${Object.keys(abis).join(", ")} to ${outFile}`);
}

main();
