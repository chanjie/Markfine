"""Publish an already-built delivery to release/<version>; never builds, installs or launches it."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import subprocess
import uuid

ROOT = Path(__file__).resolve().parents[1]
HEADER = "# Markfine 变更说明\n\n最新交付在上方；进入对应版本目录获取 `Markfine.app`。更新前请保存文档并退出旧版。\n\n"


def run(arguments):
    subprocess.run([str(value) for value in arguments], check=True, capture_output=True, text=True)


def publish(source, notes, root=ROOT):
    root = Path(root).resolve()
    source = Path(source).resolve()
    if not source.is_relative_to((root / "Dist").resolve()):
        raise ValueError("交付源必须位于项目 Dist 目录内")
    metadata = json.loads((source / "BUILD.json").read_text())
    app = source / "Markfine.app"
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    version, build = info["CFBundleShortVersionString"], info["CFBundleVersion"]
    if not re.fullmatch(r"\d+\.\d+\.\d+", version) or not re.fullmatch(r"[1-9]\d*", build):
        raise ValueError("无效的版本号或构建号")
    input_id = metadata["inputID"]
    if (not re.fullmatch(r"[a-f0-9]{64}", input_id) or info.get("MarkfineInputID") != input_id
            or metadata.get("adHocSignatureVerified") is not True or metadata.get("configuration") != "release"):
        raise ValueError("构建元数据或 Release 验证不一致")
    identifier = metadata["identifier"]
    if not re.fullmatch(re.escape(version) + r"-(mvp|dev)\." + re.escape(build) + "-" + input_id[:12], identifier):
        raise ValueError("构建标识与版本不一致")
    archive = source / ("Markfine-" + identifier + ".zip")
    if hashlib.sha256(archive.read_bytes()).hexdigest() != metadata["zipSHA256"]:
        raise ValueError("ZIP 校验失败，不交付")
    notes = notes.strip()
    if not notes:
        raise ValueError("交付必须包含本次变更说明")
    run(["codesign", "--verify", "--deep", "--strict", app])

    releases = root / "release"
    if releases.is_symlink():
        raise ValueError("release 不得为符号链接")
    releases.mkdir(exist_ok=True)
    target = releases / version
    changelog = releases / "CHANGELOG.md"
    if changelog.is_symlink():
        raise ValueError("变更说明不得为符号链接")
    marker = f"<!-- delivery:{input_id} -->"
    previous = changelog.read_text() if changelog.exists() else HEADER
    record = {"version": version, "build": build, "inputID": input_id, "source": str(source.relative_to(root))}
    if target.exists() or target.is_symlink():
        if target.is_symlink() or not (target / "DELIVERY.json").is_file():
            raise ValueError("版本目录已存在且不是本工具的交付，不覆盖")
        old = json.loads((target / "DELIVERY.json").read_text())
        if old != record or (target / "RELEASE.md").read_text() != notes + "\n":
            raise ValueError("同版本已有不同交付；请递增版本，不覆盖已有应用或说明")
        run(["codesign", "--verify", "--deep", "--strict", target / "Markfine.app"])
    else:
        # A failed copy remains a narrowly named staging directory for diagnosis; no existing delivery is removed.
        staging = releases / (".staging-" + version + "-" + uuid.uuid4().hex)
        staging.mkdir()
        run(["ditto", app, staging / "Markfine.app"])
        run(["codesign", "--verify", "--deep", "--strict", staging / "Markfine.app"])
        (staging / "BUILD.json").write_text(json.dumps(metadata, indent=2) + "\n")
        (staging / "DELIVERY.json").write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n")
        (staging / "RELEASE.md").write_text(notes + "\n")
        os.rename(staging, target)
    if marker not in previous:
        date = datetime.datetime.now().astimezone().strftime("%Y-%m-%d")
        entry = (f"{marker}\n## {version} · build {build} · {date}\n\n"
                 f"应用：[Markfine.app]({version}/Markfine.app) · [本版说明]({version}/RELEASE.md)\n\n{notes}\n\n---\n\n")
        if previous.startswith(HEADER):
            updated = HEADER + entry + previous[len(HEADER):]
        else:
            updated = HEADER + entry + previous
        temporary = releases / (".changelog-" + uuid.uuid4().hex + ".tmp")
        temporary.write_text(updated)
        os.replace(temporary, changelog)
    return target


def main():
    parser = argparse.ArgumentParser(description="整理已验证交付到 release/<版本号>，不启动或安装应用")
    parser.add_argument("source", type=Path, help="Dist 中指定的最终构建目录")
    parser.add_argument("--notes", type=Path, required=True, help="本批变更及验证边界 Markdown 文件")
    args = parser.parse_args()
    print("交付目录：" + str(publish(args.source, args.notes.read_text())))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        raise SystemExit("交付未完成：" + str(error))
