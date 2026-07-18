.PHONY: check install install-native build build-firefox build-chromium build-thunderbird build-chrome-store sign sign-listed rpm uninstall clean test test-py test-js check-version lint lint-py lint-js coverage coverage-js coverage-py

EXTENSION_DIR := extension
NATIVE_DIR := native-host
BUILD_DIR := web-ext-artifacts
VERSION := $(shell python3 -c "import json; print(json.load(open('manifests/firefox.json'))['version'])")
NAME := linux-entra-bridge

# Check prerequisites
check:
	@echo "=== Checking prerequisites ==="
	@python3 -c "import dbus" 2>/dev/null && echo "  dbus-python: OK" || (echo "  dbus-python: MISSING (pip install dbus-python)" && exit 1)
	@python3 -c "import json, struct, uuid, logging, sys" && echo "  stdlib: OK"
	@systemctl --user is-active microsoft-identity-broker.service >/dev/null 2>&1 && echo "  identity-broker: running" || echo "  identity-broker: NOT RUNNING"
	@echo "=== Testing native host ==="
	@ENTRA_SSO_DEBUG=1 python3 $(NATIVE_DIR)/linux_entra_bridge.py --test && echo "=== All checks passed ===" || echo "=== Native host test failed ==="

# Install native messaging host manifests
install-native:
	@bash $(NATIVE_DIR)/install.sh

# Build Firefox .xpi (unsigned)
build-firefox:
	cp manifests/firefox.json $(EXTENSION_DIR)/manifest.json
	@command -v npx >/dev/null 2>&1 || (echo "npm/npx required" && exit 1)
	cd $(EXTENSION_DIR) && npx web-ext build --overwrite-dest --artifacts-dir ../$(BUILD_DIR)/firefox
	rm $(EXTENSION_DIR)/manifest.json
	@echo "Built: $(BUILD_DIR)/firefox/"

# Build Chromium unpacked directory
build-chromium:
	rm -rf $(BUILD_DIR)/chromium
	mkdir -p $(BUILD_DIR)/chromium
	cp manifests/chromium.json $(BUILD_DIR)/chromium/manifest.json
	cp $(EXTENSION_DIR)/*.js $(EXTENSION_DIR)/*.html $(EXTENSION_DIR)/*.css $(BUILD_DIR)/chromium/
	cp -r $(EXTENSION_DIR)/icons $(BUILD_DIR)/chromium/
	@echo "Built: $(BUILD_DIR)/chromium/ (load unpacked in Chromium/Brave/Vivaldi)"

# Build Thunderbird .xpi (unsigned — install via TB add-on manager)
build-thunderbird:
	rm -rf $(BUILD_DIR)/thunderbird
	mkdir -p $(BUILD_DIR)/thunderbird
	cp manifests/thunderbird.json $(BUILD_DIR)/thunderbird/manifest.json
	cp $(EXTENSION_DIR)/*.js $(EXTENSION_DIR)/*.html $(EXTENSION_DIR)/*.css $(BUILD_DIR)/thunderbird/
	cp -r $(EXTENSION_DIR)/icons $(BUILD_DIR)/thunderbird/
	cd $(BUILD_DIR)/thunderbird && zip -r ../entra-id-sso-thunderbird-$(VERSION).xpi .
	@echo "Built: $(BUILD_DIR)/entra-id-sso-thunderbird-$(VERSION).xpi"

# Build all platforms
build: build-firefox build-chromium build-thunderbird

# Build Chrome Web Store .zip (chromium build with the "key" field REMOVED —
# the Web Store assigns the extension ID; the key only pins the ID for unpacked/OBS builds)
build-chrome-store:
	rm -rf $(BUILD_DIR)/chrome-store/pkg
	mkdir -p $(BUILD_DIR)/chrome-store/pkg
	python3 -c "import json; m=json.load(open('manifests/chromium.json')); m.pop('key', None); json.dump(m, open('$(BUILD_DIR)/chrome-store/pkg/manifest.json','w'), indent=2)"
	cp $(EXTENSION_DIR)/*.js $(EXTENSION_DIR)/*.html $(EXTENSION_DIR)/*.css $(BUILD_DIR)/chrome-store/pkg/
	cp -r $(EXTENSION_DIR)/icons $(BUILD_DIR)/chrome-store/pkg/
	rm -f $(BUILD_DIR)/chrome-store/$(NAME)-$(VERSION)-cws.zip
	cd $(BUILD_DIR)/chrome-store/pkg && zip -qr ../$(NAME)-$(VERSION)-cws.zip .
	@echo "Built: $(BUILD_DIR)/chrome-store/$(NAME)-$(VERSION)-cws.zip (upload to Chrome Web Store; contains no key field)"

# Sign Firefox extension via AMO (set WEB_EXT_API_KEY and WEB_EXT_API_SECRET env vars)
sign:
	cp manifests/firefox.json $(EXTENSION_DIR)/manifest.json
	npx web-ext sign --source-dir $(EXTENSION_DIR) --artifacts-dir $(BUILD_DIR)/firefox --channel=unlisted
	rm $(EXTENSION_DIR)/manifest.json
	@echo "Signed .xpi in $(BUILD_DIR)/firefox/"

# Sign + submit to the PUBLIC AMO catalogue (listed). The first submission still
# needs listing metadata (name, description, category) entered in the AMO Developer
# Hub — see contrib/amo-submission.md. Later updates can be pushed with this target.
sign-listed:
	cp manifests/firefox.json $(EXTENSION_DIR)/manifest.json
	npx web-ext sign --source-dir $(EXTENSION_DIR) --artifacts-dir $(BUILD_DIR)/firefox --channel=listed
	rm $(EXTENSION_DIR)/manifest.json
	@echo "Submitted listed version; finish metadata at addons.mozilla.org/developers/"

# Full install
install: install-native build
	@echo ""
	@echo "=== Installation complete ==="
	@echo "Firefox/LibreWolf: install .xpi from $(BUILD_DIR)/firefox/"
	@echo "Chromium/Brave:    load unpacked from $(BUILD_DIR)/chromium/"

# Uninstall
uninstall:
	rm -f ~/.mozilla/native-messaging-hosts/linux_entra_bridge.json
	rm -f ~/.librewolf/native-messaging-hosts/linux_entra_bridge.json
	rm -f ~/.config/chromium/NativeMessagingHosts/linux_entra_bridge.json
	rm -f ~/.config/google-chrome/NativeMessagingHosts/linux_entra_bridge.json
	rm -f ~/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts/linux_entra_bridge.json
	rm -f ~/.config/vivaldi/NativeMessagingHosts/linux_entra_bridge.json
	rm -rf $(BUILD_DIR)
	@echo "Native host manifests and build artifacts removed"
	@echo "Remove the extension manually from your browser"

# Clean build artifacts
clean:
	rm -rf $(BUILD_DIR) rpmbuild
	rm -f $(EXTENSION_DIR)/manifest.json

# Run all tests
test: test-py test-js

test-py:
	python3 -m pytest tests/python/ -v --tb=short

test-js:
	npx vitest run --reporter=verbose

# Coverage reports (text + HTML)
coverage: coverage-js coverage-py
	@echo "Coverage reports: coverage/js/index.html  coverage/python/index.html"

coverage-js:
	npx vitest run --coverage

coverage-py:
	@python3 -m coverage --version >/dev/null 2>&1 || { echo "Install coverage: pip install coverage"; exit 1; }
	python3 -m coverage run --source=native-host -m pytest tests/python/ -v --tb=short
	python3 -m coverage html -d coverage/python
	python3 -m coverage report

# Lint all code
lint: lint-py lint-js

lint-py:
	ruff check native-host/

lint-js:
	cp manifests/firefox.json $(EXTENSION_DIR)/manifest.json
	npx web-ext lint --source-dir $(EXTENSION_DIR) --ignore-files "*.test.*"
	rm $(EXTENSION_DIR)/manifest.json
	npx eslint extension/

# Verify version consistency across manifests and spec
check-version:
	@V=$$(python3 -c "import json; print(json.load(open('manifests/firefox.json'))['version'])"); \
	CV=$$(python3 -c "import json; print(json.load(open('manifests/chromium.json'))['version'])"); \
	SV=$$(grep '^Version:' contrib/linux-entra-bridge.spec | awk '{print $$2}'); \
	if [ "$$V" != "$$CV" ] || [ "$$V" != "$$SV" ]; then echo "VERSION MISMATCH: firefox=$$V chromium=$$CV spec=$$SV"; exit 1; fi; \
	echo "Version $$V consistent across all files"

# Build RPM package
# Build RPM package (uses chromium.json as manifest — Firefox users install the signed .xpi)
rpm:
	mkdir -p rpmbuild/{SOURCES,BUILD,RPMS,SRPMS,SPECS}
	cp manifests/chromium.json $(EXTENSION_DIR)/manifest.json
	tar czf rpmbuild/SOURCES/$(NAME)-$(VERSION).tar.gz \
		--transform 's,^,$(NAME)-$(VERSION)/,' \
		--exclude='.git' --exclude='rpmbuild' --exclude='web-ext-artifacts' --exclude='*.xpi' \
		--exclude='node_modules' --exclude='.pytest_cache' --exclude='.ruff_cache' \
		extension/ native-host/ contrib/ manifests/ LICENSE README.md Makefile
	rm $(EXTENSION_DIR)/manifest.json
	rpmbuild -bb --define "_topdir $(CURDIR)/rpmbuild" contrib/$(NAME).spec
	@echo ""
	@echo "RPM built:"
	@find rpmbuild/RPMS -name '*.rpm'
