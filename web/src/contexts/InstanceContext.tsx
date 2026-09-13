import { create } from "@bufbuild/protobuf";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef, useState } from "react";
import { instanceServiceClient } from "@/connect";
import { DEFAULT_MEMO_REACTIONS } from "@/helpers/default-reactions";
import {
  InstanceProfile,
  InstanceProfileSchema,
  InstanceSetting,
  InstanceSetting_AISetting,
  InstanceSetting_AISettingSchema,
  InstanceSetting_GeneralSetting,
  InstanceSetting_GeneralSettingSchema,
  InstanceSetting_Key,
  InstanceSetting_MemoRelatedSetting,
  InstanceSetting_MemoRelatedSettingSchema,
  InstanceSetting_NotificationSetting,
  InstanceSetting_NotificationSettingSchema,
  InstanceSetting_StorageSetting,
  InstanceSetting_StorageSettingSchema,
  InstanceSetting_TagsSetting,
  InstanceSetting_TagsSettingSchema,
} from "@/types/proto/api/v1/instance_service_pb";

const instanceSettingNamePrefix = "instance/settings/";

const buildInstanceSettingName = (key: InstanceSetting_Key): string => {
  const keyName = InstanceSetting_Key[key];
  return `${instanceSettingNamePrefix}${keyName}`;
};

interface InstanceState {
  profile: InstanceProfile;
  settings: InstanceSetting[];
  isInitialized: boolean;
  isLoading: boolean;
  // True only when the profile was successfully fetched from the server.
  // Remains false if initialization failed, so consumers can distinguish
  // "no admin exists" from "failed to load profile".
  profileLoaded: boolean;
}

interface InstanceContextValue extends InstanceState {
  generalSetting: InstanceSetting_GeneralSetting;
  memoRelatedSetting: InstanceSetting_MemoRelatedSetting;
  storageSetting: InstanceSetting_StorageSetting;
  tagsSetting: InstanceSetting_TagsSetting;
  notificationSetting: InstanceSetting_NotificationSetting;
  aiSetting: InstanceSetting_AISetting;
  initialize: () => Promise<void>;
  fetchSetting: (key: InstanceSetting_Key) => Promise<void>;
  updateSetting: (setting: InstanceSetting) => Promise<void>;
}

const InstanceContext = createContext<InstanceContextValue | null>(null);

export function InstanceProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<InstanceState>({
    profile: create(InstanceProfileSchema, {}),
    settings: [],
    isInitialized: false,
    isLoading: true,
    profileLoaded: false,
  });

  const fetchedSettingsRef = useRef<Set<string>>(new Set());

  // Memoize derived settings to prevent unnecessary recalculations
  const generalSetting = useMemo((): InstanceSetting_GeneralSetting => {
    const setting = state.settings.find((s) => s.name === `${instanceSettingNamePrefix}GENERAL`);
    if (setting?.value.case === "generalSetting") {
      const val = setting.value.value;
      return { ...val, weekStartDayOffset: val.weekStartDayOffset ?? 0 };
    }
    return create(InstanceSetting_GeneralSettingSchema, { weekStartDayOffset: 0 });
  }, [state.settings]);

  const memoRelatedSetting = useMemo((): InstanceSetting_MemoRelatedSetting => {
    const setting = state.settings.find((s) => s.name === `${instanceSettingNamePrefix}MEMO_RELATED`);
    if (setting?.value.case === "memoRelatedSetting") {
      const val = setting.value.value;
      return { ...val, reactions: val.reactions?.length ? val.reactions : [...DEFAULT_MEMO_REACTIONS] };
    }
    return create(InstanceSetting_MemoRelatedSettingSchema, { reactions: [...DEFAULT_MEMO_REACTIONS] });
  }, [state.settings]);

  const storageSetting = useMemo((): InstanceSetting_StorageSetting => {
    const setting = state.settings.find((s) => s.name === `${instanceSettingNamePrefix}STORAGE`);
    if (setting?.value.case === "storageSetting") {
      return setting.value.value;
    }
    return create(InstanceSetting_StorageSettingSchema, { uploadSizeLimitMb: BigInt(100) });
  }, [state.settings]);

  const tagsSetting = useMemo((): InstanceSetting_TagsSetting => {
    const setting = state.settings.find((s) => s.name === `${instanceSettingNamePrefix}TAGS`);
    if (setting?.value.case === "tagsSetting") {
      const val = setting.value.value;
      return { ...val, tags: val.tags || {} };
    }
    return create(InstanceSetting_TagsSettingSchema, { tags: {} });
  }, [state.settings]);

  const notificationSetting = useMemo((): InstanceSetting_NotificationSetting => {
    const setting = state.settings.find((s) => s.name === `${instanceSettingNamePrefix}NOTIFICATION`);
    if (setting?.value.case === "notificationSetting") {
      return setting.value.value;
    }
    return create(InstanceSetting_NotificationSettingSchema, {});
  }, [state.settings]);

  const aiSetting = useMemo((): InstanceSetting_AISetting => {
    const setting = state.settings.find((s) => s.name === `${instanceSettingNamePrefix}AI`);
    if (setting?.value.case === "aiSetting") {
      const val = setting.value.value;
      return { ...val, providers: val.providers || [] };
    }
    return create(InstanceSetting_AISettingSchema, { providers: [] });
  }, [state.settings]);

  const initialize = useCallback(async () => {
    setState((prev) => ({ ...prev, isLoading: true }));
    try {
      const profilePromise = instanceServiceClient.getInstanceProfile({});
      const settingsPromise = Promise.all([
        instanceServiceClient.getInstanceSetting({ name: buildInstanceSettingName(InstanceSetting_Key.GENERAL) }),
        instanceServiceClient.getInstanceSetting({ name: buildInstanceSettingName(InstanceSetting_Key.MEMO_RELATED) }),
        instanceServiceClient.getInstanceSetting({ name: buildInstanceSettingName(InstanceSetting_Key.TAGS) }),
      ]).then(([generalSetting, memoRelatedSettingResponse, tagsSettingResponse]) => {
        setState((prev) => ({
          ...prev,
          settings: [generalSetting, memoRelatedSettingResponse, tagsSettingResponse] as InstanceSetting[],
        }));
      });

      // Settings have safe local defaults, so they can finish in the background
      // while the router and the initial memo query start as soon as the profile is ready.
      void settingsPromise.catch((error) => {
        console.error("Failed to load instance settings:", error);
      });

      const profile = await profilePromise;
      setState((prev) => ({
        ...prev,
        profile,
        isInitialized: true,
        isLoading: false,
        profileLoaded: true,
      }));
    } catch (error) {
      console.error("Failed to initialize instance:", error);
      setState((prev) => ({
        ...prev,
        isInitialized: true,
        isLoading: false,
      }));
    }
  }, []);

  const fetchSetting = useCallback(async (key: InstanceSetting_Key) => {
    const name = buildInstanceSettingName(key);
    if (fetchedSettingsRef.current.has(name)) {
      return;
    }
    fetchedSettingsRef.current.add(name);
    try {
      const setting = await instanceServiceClient.getInstanceSetting({ name });
      setState((prev) => ({
        ...prev,
        settings: [...prev.settings.filter((s) => s.name !== setting.name), setting] as InstanceSetting[],
      }));
    } catch (error) {
      fetchedSettingsRef.current.delete(name);
      throw error;
    }
  }, []);

  const updateSetting = useCallback(async (setting: InstanceSetting) => {
    const updatedSetting = await instanceServiceClient.updateInstanceSetting({ setting });
    setState((prev) => ({
      ...prev,
      settings: [...prev.settings.filter((s) => s.name !== updatedSetting.name), updatedSetting],
    }));
  }, []);

  // Memoize context value to prevent unnecessary re-renders of consumers
  const value = useMemo(
    () => ({
      ...state,
      generalSetting,
      memoRelatedSetting,
      storageSetting,
      tagsSetting,
      notificationSetting,
      aiSetting,
      initialize,
      fetchSetting,
      updateSetting,
    }),
    [
      state,
      generalSetting,
      memoRelatedSetting,
      storageSetting,
      tagsSetting,
      notificationSetting,
      aiSetting,
      initialize,
      fetchSetting,
      updateSetting,
    ],
  );

  return <InstanceContext.Provider value={value}>{children}</InstanceContext.Provider>;
}

export function useInstance() {
  const context = useContext(InstanceContext);
  if (!context) {
    throw new Error("useInstance must be used within InstanceProvider");
  }
  return context;
}
