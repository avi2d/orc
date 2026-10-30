import { alertsModule } from "@tui-dash/alerts";
import { dispatchModule } from "@tui-dash/dispatch";
import { ledgerModule } from "@tui-dash/ledger";
import { queuesModule } from "@tui-dash/queues";
import { quotaModule } from "@tui-dash/quota";
import { resourcesModule } from "@tui-dash/resources";
import { schedulesModule } from "@tui-dash/schedules";
import { sessionQuotaModule } from "@tui-dash/session-quota";
import { tasksModule } from "@tui-dash/tasks";
import type { PanelModule } from "@tui-dash/ui";

const each = [quotaModule, sessionQuotaModule, alertsModule, resourcesModule, queuesModule, schedulesModule, dispatchModule, tasksModule, ledgerModule] as const;

type SourcesOf<M> = M extends PanelModule<infer R> ? R : never;

export type ModuleSources = SourcesOf<(typeof each)[number]>;

export const modules: ReadonlyArray<PanelModule<ModuleSources>> = each;
