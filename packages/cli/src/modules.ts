import { alertsModule } from "@avi2dg/orc-alerts";
import { attentionModule } from "@avi2dg/orc-attention";
import { dispatchModule } from "@avi2dg/orc-dispatch";
import { ledgerModule } from "@avi2dg/orc-ledger";
import { queuesModule } from "@avi2dg/orc-queues";
import { quotaModule } from "@avi2dg/orc-quota";
import { resourcesModule } from "@avi2dg/orc-resources";
import { schedulesModule } from "@avi2dg/orc-schedules";
import { sessionQuotaModule } from "@avi2dg/orc-session-quota";
import { tasksModule } from "@avi2dg/orc-tasks";
import type { PanelModule } from "@avi2dg/orc-ui";

const each = [quotaModule, sessionQuotaModule, alertsModule, resourcesModule, queuesModule, schedulesModule, dispatchModule, attentionModule, tasksModule, ledgerModule] as const;

type SourcesOf<M> = M extends PanelModule<infer R> ? R : never;

export type ModuleSources = SourcesOf<(typeof each)[number]>;

export const modules: ReadonlyArray<PanelModule<ModuleSources>> = each;
