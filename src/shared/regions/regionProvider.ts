/*!
 * Copyright 2018 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import globals from '../extensionGlobals'

import * as nls from 'vscode-nls'
const localize = nls.loadMessageBundle()

import * as vscode from 'vscode'
import { getLogger } from '../logger'
import { Endpoints, Region } from './endpoints'
import { EndpointsProvider } from './endpointsProvider'
import { AWSTreeNodeBase } from '../treeview/nodes/awsTreeNodeBase'
import { regionSettingKey } from '../constants'
import { AwsContext } from '../awsContext'
import { getIdeProperties, isCloud9 } from '../extensionUtilities'

export const DEFAULT_REGION = 'us-east-1'
export const DEFAULT_PARTITION = 'aws'
export const DEFAULT_DNS_SUFFIX = 'amazonaws.com'

interface RegionData {
    dnsSuffix: string
    partitionId: string
    region: Region
    serviceIds: string[]
}

export class RegionProvider {
    private readonly regionData: Map<string, RegionData> = new Map()
    private readonly onDidChangeEmitter = new vscode.EventEmitter<void>()
    public readonly onDidChange = this.onDidChangeEmitter.event

    private lastTouchedRegion?: string

    public constructor(
        endpoints: Endpoints = { partitions: [] },
        private readonly globalState = globals.context.globalState,
        private readonly awsContext: Pick<AwsContext, 'getCredentialDefaultRegion'> = globals.awsContext
    ) {
        this.loadFromEndpoints(endpoints)
    }

    public get defaultRegionId() {
        return this.awsContext.getCredentialDefaultRegion() ?? DEFAULT_REGION
    }

    public get defaultPartitionId() {
        return this.getPartitionId(this.defaultRegionId)
    }

    public isServiceInRegion(serviceId: string, regionId: string): boolean {
        return !!this.regionData.get(regionId)?.serviceIds.find(x => x === serviceId) ?? false
    }

    public getPartitionId(regionId: string): string | undefined {
        const partitionId = this.regionData.get(regionId)?.partitionId

        if (!partitionId) {
            getLogger().warn(`Unable to determine the Partition that Region ${regionId} belongs to`)
        }

        return partitionId ?? undefined
    }

    public getDnsSuffixForRegion(regionId: string): string | undefined {
        const dnsSuffix = this.regionData.get(regionId)?.dnsSuffix

        if (!dnsSuffix) {
            getLogger().warn(`Unable to find region data for: ${regionId}`)
        }

        return dnsSuffix ?? undefined
    }

    public getRegions(partitionId = this.defaultPartitionId): Region[] {
        return [...this.regionData.values()]
            .filter(region => region.partitionId === partitionId)
            .map(region => region.region)
    }

    public getExplorerRegions(): string[] {
        return this.globalState.get<string[]>(regionSettingKey, [])
    }

    public async updateExplorerRegions(regions: string[]): Promise<void> {
        return this.globalState.update(regionSettingKey, Array.from(new Set(regions)))
    }

    /**
     * @param node node on current command.
     * @returns heuristic for default region based on
     * last touched region in explorer, wizard response, and node passed in.
     */
    public guessDefaultRegion(node?: AWSTreeNodeBase): string {
        const explorerRegions = this.getExplorerRegions()

        if (node?.regionCode) {
            return node.regionCode
        } else if (explorerRegions.length === 1) {
            return explorerRegions[0]
        } else if (this.lastTouchedRegion) {
            return this.lastTouchedRegion
        } else {
            const lastWizardResponse = this.globalState.get<Region>('lastSelectedRegion')
            if (lastWizardResponse && lastWizardResponse.id) {
                return lastWizardResponse.id
            } else {
                return this.defaultRegionId
            }
        }
    }

    public setLastTouchedRegion(region: string | undefined) {
        if (region) {
            this.lastTouchedRegion = region
        }
    }

    private loadFromEndpoints(endpoints: Endpoints) {
        endpoints.partitions.forEach(partition => {
            partition.regions.forEach(region =>
                this.regionData.set(region.id, {
                    dnsSuffix: partition.dnsSuffix,
                    partitionId: partition.id,
                    region: region,
                    serviceIds: [],
                })
            )

            partition.services.forEach(service => {
                service.endpoints.forEach(endpoint => {
                    const regionData = this.regionData.get(endpoint.regionId)

                    if (regionData) {
                        regionData.serviceIds.push(service.id)
                    }
                })
            })
        })
    }

    public static fromEndpointsProvider(endpointsProvider: EndpointsProvider): RegionProvider {
        const instance = new this()

        endpointsProvider
            .load()
            .then(endpoints => {
                instance.regionData.clear()
                instance.loadFromEndpoints(endpoints)
                instance.onDidChangeEmitter.fire()
            })
            .catch(err => {
                getLogger().error('Failure while loading Endpoints Manifest: %s', err)

                vscode.window.showErrorMessage(
                    `${localize(
                        'AWS.error.endpoint.load.failure',
                        'The {0} Toolkit was unable to load endpoints data.',
                        getIdeProperties().company
                    )} ${
                        isCloud9()
                            ? localize(
                                  'AWS.error.impactedFunctionalityReset.cloud9',
                                  'Toolkit functionality may be impacted until the Cloud9 browser tab is refreshed.'
                              )
                            : localize(
                                  'AWS.error.impactedFunctionalityReset.vscode',
                                  'Toolkit functionality may be impacted until VS Code is restarted.'
                              )
                    }`
                )
            })

        return instance
    }
}
