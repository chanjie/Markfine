"""Build the standalone macOS application. Never launches or installs the application."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys
import uuid

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / "Build/Product"
ARCHITECTURES = ("arm64", "x86_64")


def source_files():
    """Only shared product inputs; local tests and workspace files never affect the build."""
    files = [ROOT / "Package.swift", ROOT / "LICENSE", ROOT / "Config/Build.json", ROOT / "Config/Markfine.png", ROOT / "Config/Markfine.icns", ROOT / "Scripts/build.py", ROOT / "Scripts/draw-icon.swift", ROOT / "Scripts/draw-paper.py"]
    files += [ROOT / "Web/textures" / name for name in ["paper-texture.png", "kraft-texture.png"]]
    files += [ROOT / "Web" / name for name in ["package.json", "package-lock.json", "tsconfig.json", "build.mjs", "index.html", "style.css"]]
    for directory in ["Sources", "Web/src"]:
        files += [path for path in (ROOT / directory).rglob("*") if path.is_file() and path.suffix in [".swift", ".ts"]]
    return sorted(files)


def input_digest():
    digest = hashlib.sha256()
    for path in source_files():
        digest.update(str(path.relative_to(ROOT)).encode() + b"\0")
        digest.update(hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()


def environment():
    return dict(os.environ, PYTHONDONTWRITEBYTECODE="1", CLANG_MODULE_CACHE_PATH=str(WORK / "Cache/clang-modules"),
                SWIFTPM_MODULECACHE_OVERRIDE=str(WORK / "Cache/swift-modules"), XDG_CACHE_HOME=str(WORK / "Cache/xdg"),
                npm_config_cache=str(WORK / "Cache/npm"), npm_config_userconfig=str(WORK / "Cache/npm-userconfig"),
                npm_config_audit="false", npm_config_fund="false", npm_config_update_notifier="false")


def run(arguments, env, cwd=ROOT):
    arguments = [str(value) for value in arguments]
    print("+ " + " ".join(arguments), flush=True)
    result = subprocess.run(arguments, cwd=cwd, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=600)
    print(result.stdout, end="", flush=True)
    if result.returncode:
        raise RuntimeError("Command failed: " + arguments[0])
    return result.stdout


def swift_arguments(configuration, architecture):
    if architecture not in ARCHITECTURES:
        raise ValueError("Unsupported architecture: " + architecture)
    return ["swift", "build", "--package-path", ROOT, "--scratch-path", WORK / "Swift" / architecture,
            "--cache-path", WORK / "Cache/swiftpm", "--config-path", WORK / "Cache/swift-config",
            "--security-path", WORK / "Cache/swift-security", "--manifest-cache", "local", "--disable-dependency-cache",
            "--disable-index-store", "--disable-netrc", "--disable-keychain", "--arch", architecture, "-c", configuration,
            "-Xswiftc", "-module-cache-path", "-Xswiftc", WORK / "Cache/swift-modules" / architecture]


def verify_binary(binary, env):
    architectures = run(["lipo", "-archs", binary], env).split()
    if len(architectures) != len(ARCHITECTURES) or set(architectures) != set(ARCHITECTURES):
        raise RuntimeError("Universal application must contain arm64 and x86_64")
    for architecture in ARCHITECTURES:
        libraries = run(["otool", "-arch", architecture, "-L", binary], env)
        for line in libraries.splitlines()[1:]:
            dependency = line.strip().split(" (", 1)[0]
            if not dependency.startswith(("/System/Library/", "/usr/lib/")):
                raise RuntimeError("Unexpected non-system runtime dependency: " + dependency)
    return list(ARCHITECTURES)


def verify_resources(directory, input_id):
    manifest = json.loads((directory / "manifest.json").read_text())
    expected = manifest["files"]
    required = {"index.html", "style.css", "app.js", "mermaid-runtime.js", "build-info.json", "ThirdPartyNotices.txt", "dependencies.json", "paper-texture.png", "kraft-texture.png"}
    if manifest["format"] != 1 or manifest["inputID"] != input_id or not required.issubset(expected):
        raise RuntimeError("Resource manifest identity or required files differ")
    if set(path.name for path in directory.iterdir()) != set(expected) | {"manifest.json"}:
        raise RuntimeError("Unexpected packaged resource files")
    for name, digest in expected.items():
        path = directory / name
        if not re.fullmatch(r"[A-Za-z0-9_.-]+", name) or path.is_symlink() or not path.is_file():
            raise RuntimeError("Unsafe resource name/type: " + name)
        if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise RuntimeError("Resource checksum differs: " + name)
    info = json.loads((directory / "build-info.json").read_text())
    if info["inputID"] != input_id:
        raise RuntimeError("Build metadata does not match resources")


def build(configuration, env):
    if run(["uname", "-s"], env).strip() != "Darwin":
        raise RuntimeError("Build Markfine on macOS")
    if not (ROOT / "Web/node_modules/esbuild").is_dir():
        raise RuntimeError("Missing pinned dependencies. Run python3 Scripts/build.py install")
    config = json.loads((ROOT / "Config/Build.json").read_text())
    if not re.fullmatch(r"\d+\.\d+\.\d+", config["version"]) or type(config["build"]) is not int or config["build"] <= 0:
        raise RuntimeError("Invalid version/build metadata")
    if config["stage"] not in ["development", "mvp-candidate"]:
        raise RuntimeError("Unknown build stage")
    input_id = input_digest()
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
    directory = WORK / "Runs" / stamp
    directory.mkdir(parents=True, exist_ok=False)
    env = dict(env, MARKFINE_INPUT_ID=input_id, MARKFINE_WEB_OUTPUT=str(directory / "Editor"))
    run(["node", "build.mjs"], env, cwd=ROOT / "Web")
    run(["npm", "run", "check"], env, cwd=ROOT / "Web")
    binaries = []
    for architecture in ARCHITECTURES:
        arguments = swift_arguments(configuration, architecture)
        run(arguments + ["--product", "Markfine"], env)
        binary_directory = Path(run(arguments + ["--show-bin-path"], env).strip().splitlines()[-1])
        if not binary_directory.resolve().is_relative_to((WORK / "Swift" / architecture).resolve()):
            raise RuntimeError("Unexpected Swift output location")
        binary = binary_directory / "Markfine"
        if run(["lipo", "-archs", binary], env).split() != [architecture]:
            raise RuntimeError("Swift output architecture differs: " + architecture)
        binaries.append(binary)
    stage = "mvp" if config["stage"] == "mvp-candidate" else "dev"
    identifier = f"{config['version']}-{stage}.{config['build']}-{input_id[:12]}"
    output = ROOT / "Dist" / identifier / stamp
    app = output / "Markfine.app"
    (app / "Contents/MacOS").mkdir(parents=True, exist_ok=False)
    (app / "Contents/Resources").mkdir()
    run(["lipo", "-create", *binaries, "-output", app / "Contents/MacOS/Markfine"], env)
    shutil.copytree(directory / "Editor", app / "Contents/Resources/Editor")
    shutil.copy2(ROOT / "Config/Markfine.icns", app / "Contents/Resources/Markfine.icns")
    shutil.copy2(ROOT / "LICENSE", app / "Contents/Resources/LICENSE.txt")
    info = {
        "CFBundleDevelopmentRegion": "zh_CN", "CFBundleExecutable": "Markfine", "CFBundleName": "Markfine",
        "CFBundleDisplayName": "Markfine", "CFBundleIdentifier": "local.markfine.Markfine", "CFBundlePackageType": "APPL",
        "CFBundleIconFile": "Markfine.icns",
        "CFBundleLocalizations": ["zh_CN", "en"],
        "CFBundleShortVersionString": config["version"], "CFBundleVersion": str(config["build"]),
        "LSMinimumSystemVersion": "13.0", "NSHighResolutionCapable": True, "NSPrincipalClass": "NSApplication",
        "MarkfineBuildStage": config["stage"], "MarkfineInputID": input_id,
        "NSHumanReadableCopyright": "Copyright © 2026 Markfine contributors. MIT License. Third-party components retain their own licenses.",
        "CFBundleDocumentTypes": [{"CFBundleTypeName": "Markdown document", "CFBundleTypeRole": "Editor", "LSHandlerRank": "Alternate",
                                   "LSItemContentTypes": ["net.daringfireball.markdown"]},
                                  {"CFBundleTypeName": "Plain text and source code", "CFBundleTypeRole": "Editor", "LSHandlerRank": "Alternate",
                                   "LSItemContentTypes": ["public.plain-text", "public.source-code"]}],
        "UTImportedTypeDeclarations": [{"UTTypeIdentifier": "net.daringfireball.markdown", "UTTypeDescription": "Markdown document",
                                        "UTTypeConformsTo": ["public.plain-text"], "UTTypeTagSpecification": {
                                            "public.filename-extension": ["md", "markdown"], "public.mime-type": ["text/markdown", "text/x-markdown"]}}],
    }
    (app / "Contents/Info.plist").write_bytes(plistlib.dumps(info))
    verify_resources(app / "Contents/Resources/Editor", input_id)
    architectures = verify_binary(app / "Contents/MacOS/Markfine", env)
    run(["codesign", "--force", "--sign", "-", "--timestamp=none", app], env)
    run(["codesign", "--verify", "--deep", "--strict", "--verbose=2", app], env)
    archive = output / ("Markfine-" + identifier + ".zip")
    run(["ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", app, archive], env)
    checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
    (output / (archive.name + ".sha256")).write_text(checksum + "  " + archive.name + "\n")
    unpacked = directory / "Unpacked"
    unpacked.mkdir()
    run(["ditto", "-x", "-k", archive, unpacked], env)
    run(["codesign", "--verify", "--deep", "--strict", "--verbose=2", unpacked / "Markfine.app"], env)
    verify_resources(unpacked / "Markfine.app/Contents/Resources/Editor", input_id)
    verify_binary(unpacked / "Markfine.app/Contents/MacOS/Markfine", env)
    if hashlib.sha256((app / "Contents/MacOS/Markfine").read_bytes()).digest() != hashlib.sha256((unpacked / "Markfine.app/Contents/MacOS/Markfine").read_bytes()).digest():
        raise RuntimeError("Unpacked application binary differs")
    if input_digest() != input_id:
        raise RuntimeError("Source changed during build; this output is not a verified build")
    metadata = {"identifier": identifier, "inputID": input_id, "configuration": configuration, "architecture": "universal", "architectures": architectures,
                "zipSHA256": checksum, "adHocSignatureVerified": True, "notarized": False, "applicationLaunched": False}
    (output / "BUILD.json").write_text(json.dumps(metadata, indent=2) + "\n")
    shutil.copy2(ROOT / "docs/USAGE.md", output / "USAGE.md")
    print("Application: " + str(app.relative_to(ROOT)), flush=True)
    return output


def main():
    parser = argparse.ArgumentParser(description="Build/package Markfine without launching or installing it.")
    parser.add_argument("command", nargs="?", choices=["build", "install"], default="build")
    parser.add_argument("--configuration", choices=["release", "debug"], default="release")
    arguments = parser.parse_args()
    env = environment()
    if arguments.command == "install":
        run(["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"], env, cwd=ROOT / "Web")
    else:
        build(arguments.configuration, env)


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        raise SystemExit(str(error))
