import AppKit
import MarkfineCore

@MainActor
final class ImageStoragePreferences: NSObject {
    let storage: S3Settings; let settings: ApplicationSettings
    var onChange: (() -> Void)?
    private let root = NSStackView(), fields = NSStackView()
    private let endpoint = NSTextField(), region = NSTextField(), bucket = NSTextField(), prefix = NSTextField(), publicBase = NSTextField(), accessKey = NSTextField()
    private let secret = NSSecureTextField(), token = NSSecureTextField()
    private let access = NSPopUpButton(), pathStyle = NSButton(checkboxWithTitle: "", target: nil, action: nil), mode = NSPopUpButton()
    private let status = NSTextField(wrappingLabelWithString: "")
    private let saveButton = NSButton(), removeButton = NSButton()
    init(storage: S3Settings, settings: ApplicationSettings) { self.storage = storage; self.settings = settings }
    func makeView() -> NSView {
        root.orientation = .vertical; root.alignment = .leading; root.spacing = 14
        fields.orientation = .vertical; fields.alignment = .leading; fields.spacing = 11
        mode.addItems(withTitles: [text("本地", "Local"), "S3"]); mode.selectItem(at: storage.destination == "s3" ? 1 : 0); mode.target = self; mode.action = #selector(changeMode)
        row(text("图片粘贴位置", "Paste images to"), mode, into: root)
        note(text("用于之后粘贴的图片。", "Applies to images pasted afterwards."), into: root)
        let profile = storage.profile
        endpoint.stringValue = profile?.endpoint ?? ""; endpoint.placeholderString = "https://"
        region.stringValue = profile?.region ?? "us-east-1"; bucket.stringValue = profile?.bucket ?? ""; prefix.stringValue = profile?.prefix ?? ""; publicBase.stringValue = profile?.publicBase ?? ""
        for (label, field) in [(text("服务地址", "Service URL"), endpoint), (text("区域", "Region"), region), (text("存储桶", "Bucket"), bucket), (text("图片目录", "Image prefix"), prefix)] { row(label, field, into: fields) }
        pathStyle.title = text("使用路径式地址（Path style）", "Use path-style URLs"); pathStyle.state = profile?.pathStyle == false ? .off : .on; fields.addArrangedSubview(pathStyle)
        access.addItems(withTitles: [text("使用凭据读取", "Read with credentials"), text("公开链接访问", "Public image links")]); access.selectItem(at: profile?.access == "public" ? 1 : 0); access.target = self; access.action = #selector(changeAccess)
        row(text("图片访问方式", "Image access"), access, into: fields)
        row(text("图片访问根地址", "Public base URL"), publicBase, into: fields)
        note(text("公开地址对应存储桶根目录；访问方式需与存储服务权限一致。", "The public address maps to the bucket root. Match the access mode to your storage permissions."), into: fields)
        row("Access Key ID", accessKey, into: fields); row("Secret Access Key", secret, into: fields); row(text("临时令牌（可选）", "Session token (optional)"), token, into: fields)
        note(text("凭据保存在系统钥匙串。已保存时可留空继续使用；更改服务地址、区域、存储桶、图片目录或地址形式需重新填写。", "Credentials are stored in Keychain. Leave them empty to reuse saved credentials. Enter them again when changing the service URL, region, bucket, image prefix or URL style."), into: fields)
        saveButton.title = text("保存并使用 S3", "Save and Use S3"); saveButton.bezelStyle = .rounded; saveButton.target = self; saveButton.action = #selector(save)
        removeButton.title = text("删除凭据…", "Delete Credentials…"); removeButton.bezelStyle = .rounded; removeButton.target = self; removeButton.action = #selector(remove)
        let actions = NSStackView(views: [saveButton, removeButton]); actions.spacing = 12; fields.addArrangedSubview(actions)
        status.font = .systemFont(ofSize: 11); status.textColor = .secondaryLabelColor; status.stringValue = profile == nil ? "" : text("凭据已保存", "Credentials saved"); fields.addArrangedSubview(status)
        root.addArrangedSubview(fields); fields.isHidden = mode.indexOfSelectedItem == 0; changeAccess(); return root
    }
    func clearSecrets() { accessKey.stringValue = ""; secret.stringValue = ""; token.stringValue = "" }
    private func text(_ zh: String, _ en: String) -> String { settings.text(zh, en) }
    private func row(_ title: String, _ control: NSView, into stack: NSStackView) {
        let label = NSTextField(labelWithString: title); label.widthAnchor.constraint(equalToConstant: 150).isActive = true
        control.widthAnchor.constraint(equalToConstant: 350).isActive = true; let row = NSStackView(views: [label, control]); row.spacing = 12; stack.addArrangedSubview(row)
    }
    private func note(_ title: String, into stack: NSStackView) { let field = NSTextField(wrappingLabelWithString: title); field.font = .systemFont(ofSize: 11); field.textColor = .secondaryLabelColor; field.widthAnchor.constraint(lessThanOrEqualToConstant: 520).isActive = true; stack.addArrangedSubview(field) }
    @objc private func changeMode() { fields.isHidden = mode.indexOfSelectedItem == 0; if fields.isHidden { storage.useLocal(); clearSecrets(); onChange?() } }
    @objc private func changeAccess() { publicBase.isEnabled = access.indexOfSelectedItem == 1 }
    @objc private func save() {
        let profile = S3Profile(endpoint: endpoint.stringValue.trimmingCharacters(in: .whitespacesAndNewlines), region: region.stringValue, bucket: bucket.stringValue, prefix: prefix.stringValue, pathStyle: pathStyle.state == .on, access: access.indexOfSelectedItem == 1 ? "public" : "credentials", publicBase: publicBase.stringValue)
        let credentials = accessKey.stringValue.isEmpty && secret.stringValue.isEmpty && token.stringValue.isEmpty ? nil : S3Credentials(accessKey: accessKey.stringValue, secretKey: secret.stringValue, token: token.stringValue)
        guard profile.valid else { status.stringValue = text("请检查 HTTPS 地址、区域、存储桶和图片目录。", "Check the HTTPS URLs, region, bucket and image prefix."); return }
        saveButton.isEnabled = false; removeButton.isEnabled = false; status.stringValue = text("正在保存凭据…", "Saving credentials…")
        let changed = onChange, ticket = storage.beginChange()
        Task { [weak self, storage] in
            do { try await Task.detached { try storage.save(profile, credentials: credentials, ticket: ticket) }.value; self?.clearSecrets(); self?.status.stringValue = self?.text("配置已保存，之后粘贴的图片使用 S3。", "Configuration saved. New pasted images use S3.") ?? ""; changed?() }
            catch S3Failure.superseded { self?.clearSecrets(); self?.status.stringValue = self?.text("存储选择已更新，本次保存已取消。", "Storage selection changed. This save was cancelled.") ?? "" }
            catch { self?.status.stringValue = self?.text("未保存配置，请检查凭据或按系统提示授权钥匙串。", "Configuration was not saved. Check the credentials or allow Keychain access when prompted.") ?? "" }
            self?.saveButton.isEnabled = true; self?.removeButton.isEnabled = true
        }
    }
    @objc private func remove() {
        guard let window = root.window else { return }; let alert = NSAlert(); alert.messageText = text("删除已保存的 S3 凭据？", "Delete the saved S3 credentials?")
        alert.addButton(withTitle: text("删除", "Delete")); alert.addButton(withTitle: text("取消", "Cancel"))
        alert.beginSheetModal(for: window) { [weak self] response in
            guard response == .alertFirstButtonReturn, let self else { return }
            let ticket = self.storage.beginChange()
            Task { do { try await Task.detached { try self.storage.removeCredentials(ticket: ticket) }.value; self.clearSecrets(); self.mode.selectItem(at: 0); self.fields.isHidden = true; self.status.stringValue = self.text("凭据已删除", "Credentials deleted"); self.onChange?() } catch { self.status.stringValue = self.text("凭据删除未完成，请按系统提示处理。", "Credentials could not be deleted. Follow the system prompt.") } }
        }
    }
}
