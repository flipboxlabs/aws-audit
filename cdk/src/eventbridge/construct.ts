import type { CDKConfig } from "@flipboxlabs/aws-audit-cdk";
import { EventBridge } from "@flipboxlabs/aws-audit-sdk";
import * as events from "aws-cdk-lib/aws-events";
import { Construct } from "constructs";

export class EventBridgeConstruct extends Construct {
  public readonly eventBus: events.IEventBus;

  constructor(
    scope: Construct,
    id: string,
    props: {
      config: CDKConfig;
    },
  ) {
    super(scope, id);

    // Our audit event bus
    this.eventBus = new events.EventBus(this, "EventBus", {
      eventBusName: EventBridge.Bus.Name(props.config),
    });
  }
}
