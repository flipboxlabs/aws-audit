// Check that every Rust Lambda (rust/lambdas/<name>) has an arm64 Linux binary at
// assets/lambda/<name>/bootstrap, so the package never publishes without one, or
// with a test stub or a binary built for the wrong machine.
//
// Run by prepublishOnly and after `pnpm build:lambdas`.
import * as fs from "node:fs";
import * as path from "node:path";

const cdkDir = path.resolve(import.meta.dirname, "..");
const lambdasDir = path.join(cdkDir, "rust", "lambdas");
const assetsDir = path.join(cdkDir, "assets", "lambda");

// ELF header: magic, 64-bit class, little-endian, and e_machine EM_AARCH64 (183)
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
const ELF_CLASS_64 = 2;
const ELF_DATA_LITTLE_ENDIAN = 1;
const EM_AARCH64 = 183;

const lambdas = fs.existsSync(lambdasDir)
  ? fs
      .readdirSync(lambdasDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => fs.existsSync(path.join(lambdasDir, entry.name, "Cargo.toml")))
      .map((entry) => entry.name)
      .sort()
  : [];

const problem = (name) => {
  const bootstrap = path.join(assetsDir, name, "bootstrap");
  if (!fs.existsSync(bootstrap)) {
    return `${bootstrap} is missing`;
  }

  const header = Buffer.alloc(20);
  const fd = fs.openSync(bootstrap, "r");
  try {
    fs.readSync(fd, header, 0, header.length, 0);
  } finally {
    fs.closeSync(fd);
  }

  if (!header.subarray(0, 4).equals(ELF_MAGIC)) {
    return `${bootstrap} isn't an ELF binary`;
  }
  if (
    header[4] !== ELF_CLASS_64 ||
    header[5] !== ELF_DATA_LITTLE_ENDIAN ||
    header.readUInt16LE(18) !== EM_AARCH64
  ) {
    return `${bootstrap} isn't built for arm64 (aarch64)`;
  }

  return undefined;
};

const problems = lambdas.map(problem).filter(Boolean);

if (problems.length > 0) {
  console.error(
    `Rust Lambda binaries aren't ready; run \`pnpm build:lambdas\` in the cdk package:\n${problems
      .map((p) => `  - ${p}`)
      .join("\n")}`,
  );
  process.exit(1);
}

console.log(
  lambdas.length > 0
    ? `Rust Lambda binaries ready: ${lambdas.join(", ")}`
    : "No Rust Lambdas under rust/lambdas.",
);
