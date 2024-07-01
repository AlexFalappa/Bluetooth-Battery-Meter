'use strict';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';
import {BluetoothIndicator} from './bluetoothIndicator.js';
import {BluetoothDeviceItem} from './bluetoothPopupMenu.js';

const QuickSettingsMenu = Main.panel.statusArea.quickSettings;
const supportedIcons = [
    'audio-speakers',
    'audio-headphones',
    'audio-headset',
    'input-gaming',
    'input-keyboard',
    'input-mouse',
    'input-tablet',
    'phone-apple-iphone',
    'phone-samsung-galaxy-s',
    'phone-google-nexus-one',
    'phone',
];

export const BluetoothBatteryMeter = GObject.registerClass({
}, class BluetoothBatteryMeter extends GObject.Object {
    constructor(settings, extensionPath) {
        super();
        this._extensionPath = extensionPath;
        this._settings = settings;

        this._idleTimerId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            if (!Main.panel.statusArea.quickSettings._bluetooth)
                return GLib.SOURCE_CONTINUE;
            this._bluetoothToggle = Main.panel.statusArea.quickSettings._bluetooth.quickSettingsItems[0];
            this._startBluetoothToggle();
            return GLib.SOURCE_REMOVE;
        });
    }

    _startBluetoothToggle() {
        this._idleTimerId = null;
        this._deviceItems = new Map();
        this._deviceIndicators = new Map();
        this._pairedBatteryDevices = new Map();
        this._removedDeviceList = [];
        this._pullDevicesFromGsetting();
        this._showBatteryPercentage = this._settings.get_boolean('enable-battery-level-text');
        this._showBatteryIcon = this._settings.get_boolean('enable-battery-level-icon');
        this._swapIconText = this._settings.get_boolean('swap-icon-text');
        this._desktopSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._desktopSettings.connectObject(
            'changed::text-scaling-factor', () => {
                this._onActiveChanged();
            },
            this
        );

        this._settings.connectObject(
            'changed::enable-battery-indicator', () => {
                if (this._settings.get_boolean('enable-battery-indicator'))
                    this._sync();
                else
                    this._destroyIndicators();
            },
            'changed::enable-battery-level-text', () => {
                this._showBatteryPercentage = this._settings.get_boolean('enable-battery-level-text');
                this._onActiveChanged();
            },
            'changed::enable-battery-level-icon', () => {
                this._showBatteryIcon = this._settings.get_boolean('enable-battery-level-icon');
                this._onActiveChanged();
            },
            'changed::swap-icon-text', () => {
                this._swapIconText = this._settings.get_boolean('swap-icon-text');
                this._onActiveChanged();
            },
            'changed::paired-supported-device-list', () => {
                this._pullDevicesFromGsetting();
                this._sync();
            },
            this
        );
        this._originalSync = this._bluetoothToggle._sync;
        this._bluetoothToggle._sync = () => {
            this._sync();
        };
        this._originalRemoveDevice = this._bluetoothToggle._removeDevice;
        this._bluetoothToggle._removeDevice = path => {
            this._removeDevice(path);
        };
        this._bluetoothToggle._onActiveChanged();
        this._originalOnActiveChanged = this._bluetoothToggle._onActiveChanged;
        this._bluetoothToggle._onActiveChanged = path => {
            this._onActiveChanged(path);
        };
    }

    _removeDevice(path) {
        this._deviceItems.get(path)?.destroy();
        this._deviceItems.delete(path);
        this._removedDeviceList.push(path);
        if (this._pairedBatteryDevices.has(path)) {
            const props = this._pairedBatteryDevices.get(path);
            props.paired = false;
            this._pairedBatteryDevices.set(path, props);
            this._pushDevicesToGsetting();
        }
        this._deviceIndicators.get(path)?.destroy();
        this._deviceIndicators.delete(path);
        this._updateDeviceVisibility();
    }

    _updateDeviceVisibility() {
        this._bluetoothToggle._deviceSection.actor.visible =
            [...this._deviceItems.values()].some(item => item.visible);
    }

    _onActiveChanged() {
        this._bluetoothToggle._updatePlaceholder();
        this._deviceItems.forEach(item => item.destroy());
        this._deviceItems.clear();
        this._sync();
    }

    _pullDevicesFromGsetting() {
        this._pairedBatteryDevices.clear();
        const deviceList = this._settings.get_strv('paired-supported-device-list');
        if (deviceList.length !== 0) {
            for (const jsonString of deviceList) {
                const item = JSON.parse(jsonString);
                const path = item.path;
                const props = {
                    'icon': item['icon'],
                    'alias': item['alias'],
                    'paired': item['paired'],
                    'batteryEnabled': item['battery-enabled'],
                    'indicatorEnabled': item['indicator-enabled'],
                };
                this._pairedBatteryDevices.set(path, props);
            }
        }
    }

    _pushDevicesToGsetting() {
        const deviceList = [];
        for (const [path, props] of this._pairedBatteryDevices) {
            const item = {
                path,
                'icon': props.icon,
                'alias': props.alias,
                'paired': props.paired,
                'battery-enabled': props.batteryEnabled,
                'indicator-enabled': props.indicatorEnabled,
            };
            deviceList.push(JSON.stringify(item));
        }
        this._settings.set_strv('paired-supported-device-list', deviceList);
    }

    addBatterySupportedDevices(device) {
        const path = device.get_object_path();
        const props = {
            icon: device.icon,
            alias: device.alias,
            paired: true,
            batteryEnabled: true,
            indicatorEnabled: true,
        };
        this._pairedBatteryDevices.set(path, props);
        this._delayedUpdateDeviceGsettings();
    }

    _delayedUpdateDeviceGsettings() {
        if (this._delayedTimerId)
            GLib.source_remove(this._delayedTimerId);
        this._delayedTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._pushDevicesToGsetting();
            this._delayedTimerId = null;
            return GLib.SOURCE_REMOVE;
        });
    }

    _sync() {
        const devices = this._bluetoothToggle._getSortedDevices();
        if (this._removedDeviceList.length > 0) {
            const pathsInDevices = new Set(devices.map(dev => dev.get_object_path()));
            this._removedDeviceList = this._removedDeviceList.filter(path => pathsInDevices.has(path));
        }

        for (const dev of devices) {
            const path = dev.get_object_path();
            if (this._deviceItems.has(path)) {
                if (this._pairedBatteryDevices.has(path)) {
                    const item = this._deviceItems.get(path);
                    item.updateProps(this._pairedBatteryDevices.get(path).batteryEnabled);
                }
                continue;
            }
            if (this._removedDeviceList.length > 0) {
                const pathIndex = this._removedDeviceList.indexOf(path);
                if (pathIndex > -1) {
                    if (dev.connected)
                        this._removedDeviceList.splice(pathIndex, 1);
                    else
                        continue;
                }
            }

            let batteryInfoReported = false;
            let props = {};
            const iconCompatible = supportedIcons.includes(dev.icon);
            if (iconCompatible) {
                if (this._pairedBatteryDevices.has(path)) {
                    let updateGsettingPairedList = false;
                    props = this._pairedBatteryDevices.get(path);
                    if (props.alias !== dev.alias) {
                        props.alias = dev.alias;
                        updateGsettingPairedList = true;
                    }
                    if (props.paired !== dev.paired) {
                        props.paired = dev.paired;
                        updateGsettingPairedList = true;
                    }
                    if (updateGsettingPairedList)
                        this._delayedUpdateDeviceGsettings();
                    batteryInfoReported = true;
                } else if (dev.battery_percentage > 0) {
                    this.addBatterySupportedDevices(dev);
                    batteryInfoReported = true;
                }
            }

            const item = new BluetoothDeviceItem(this, dev, iconCompatible, batteryInfoReported);
            item.connect('notify::visible', () => this._updateDeviceVisibility());
            if (batteryInfoReported)
                item.updateProps(props.batteryEnabled);
            else
                item.updateProps(false);
            this._bluetoothToggle._deviceSection.addMenuItem(item);
            this._deviceItems.set(path, item);
        }

        if (this._settings.get_boolean('enable-battery-indicator')) {
            for (const dev of devices) {
                const path = dev.get_object_path();
                if (this._deviceIndicators.has(path)) {
                    if (!dev.connected || !this._pairedBatteryDevices.get(path).indicatorEnabled) {
                        this._deviceIndicators.get(path)?.destroy();
                        this._deviceIndicators.delete(path);
                    }
                    continue;
                }
                if (this._pairedBatteryDevices.has(path) && this._pairedBatteryDevices.get(path).indicatorEnabled) {
                    const indicator = new BluetoothIndicator(this._settings, dev, this._extensionPath);
                    QuickSettingsMenu.addExternalIndicator(indicator);
                    this._deviceIndicators.set(path, indicator);
                }
            }
        }

        const connectedDevices = devices.filter(dev => dev.connected);
        const nConnected = connectedDevices.length;

        if (nConnected > 1)

            this._bluetoothToggle.subtitle = ngettext('%d Connected', '%d Connected', nConnected).format(nConnected);
        else if (nConnected === 1)
            this._bluetoothToggle.subtitle = connectedDevices[0].alias;
        else
            this._bluetoothToggle.subtitle = null;

        this._updateDeviceVisibility();
    }

    _destroyIndicators() {
        if (this._deviceIndicators) {
            this._deviceIndicators.forEach(indicator => indicator?.destroy());
            this._deviceIndicators.clear();
        }
    }

    _destroyPopupMenuItems() {
        if (this._deviceItems) {
            this._deviceItems.forEach(item => item.destroy());
            this._deviceItems.clear();
        }
    }

    destroy() {
        if (this._idleTimerId)
            GLib.source_remove(this._idleTimerId);
        this._idleTimerId = null;
        this._settings.disconnectObject(this);
        if (this._delayedTimerId)
            GLib.source_remove(this._delayedTimerId);
        this._delayedTimerId = null;
        if (this._desktopSettings)
            this._desktopSettings.disconnectObject(this);
        this._destroyIndicators();
        this._deviceIndicators = null;
        this._destroyPopupMenuItems();
        this._deviceItems = null;
        this._pairedBatteryDevices = null;
        this._desktopSettings = null;
        this._settings = null;
        if (this._bluetoothToggle && this._originalRemoveDevice)
            this._bluetoothToggle._removeDevice = this._originalRemoveDevice;
        this._originalRemoveDevice = null;
        if (this._bluetoothToggle && this._originalSync)
            this._bluetoothToggle._sync = this._originalSync;
        this._originalSync = null;
        if (this._bluetoothToggle && this._originalOnActiveChanged)
            this._bluetoothToggle._onActiveChanged = this._originalOnActiveChanged;
        this._originalRemoveDevice = null;
        this._bluetoothToggle?._onActiveChanged();
    }
});

