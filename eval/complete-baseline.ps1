param()

$ErrorActionPreference = 'Stop'
$evalRoot = $PSScriptRoot
$projectRoot = Split-Path $evalRoot -Parent
$runRoot = Join-Path $evalRoot 'runs/2026-10-11-remaining'
$casePath = Join-Path $evalRoot 'test-cases.json'
$csvPath = Join-Path $evalRoot 'manual-scorecard.csv'
$review = Get-Content -Raw -LiteralPath (Join-Path $evalRoot 'remaining-review.json') | ConvertFrom-Json
$cases = @(Get-Content -Raw -LiteralPath $casePath | ConvertFrom-Json)
$rows = @(Import-Csv -LiteralPath $csvPath)
$metadata = Get-Content -Raw -LiteralPath (Join-Path $runRoot 'run-metadata.json') | ConvertFrom-Json
$definitions = @($cases | Select-Object id,group,name,turns,checkpoints) | ConvertTo-Json -Depth 10 -Compress

function Set-Field($Object, [string]$Name, $Value) {
    $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value -Force
}

function Save-Json($Value, [string]$Path) {
    $Value | ConvertTo-Json -Depth 50 | Set-Content -LiteralPath $Path -Encoding utf8
}

function Measure-Cases($SelectedRows) {
    $count = @($SelectedRows).Count
    $passed = @($SelectedRows | Where-Object case_pass -EQ '是').Count
    $dimensions = [ordered]@{}
    $dimensionPassed = 0
    foreach ($dim in @('d1','d2','d3','d4')) {
        $sum = 0
        foreach ($row in $SelectedRows) { $sum += [int]$row.$dim }
        $dimensionPassed += $sum
        $dimensions[$dim.ToUpper()] = [ordered]@{ passed=$sum; total=$count; ratePercent=[Math]::Round(100*$sum/$count,2) }
    }
    $checkpointPassed = 0
    $checkpointTotal = 0
    $layers = [ordered]@{ L1=0; L2=0; L3=0; L4=0 }
    foreach ($row in $SelectedRows) {
        foreach ($checkpoint in ($row.checkpoint_results -split ';')) {
            $checkpointTotal++
            $checkpointPassed += [int]$checkpoint
        }
        if ($row.case_pass -eq '否') {
            if (-not $layers.Contains($row.primary_layer)) { throw "Invalid failure layer: $($row.case_id)" }
            $layers[$row.primary_layer]++
        }
    }
    $average = 100*$dimensionPassed/(4*$count)
    return [ordered]@{
        total=$count; passed=$passed; failed=$count-$passed; taskCompletionRatePercent=[Math]::Round(100*$passed/$count,2)
        dimensions=$dimensions; compositeDimensionRatePercent=[Math]::Round($average,2)
        checkpoints=[ordered]@{ passed=$checkpointPassed; total=$checkpointTotal; ratePercent=[Math]::Round(100*$checkpointPassed/$checkpointTotal,2) }
        primaryFailureLayers=$layers
        criticalFailures=@($SelectedRows | Where-Object critical_failure -EQ '是' | ForEach-Object case_id)
        passedCaseIds=@($SelectedRows | Where-Object case_pass -EQ '是' | ForEach-Object case_id)
    }
}

if ($cases.Count -ne 36 -or $rows.Count -ne 36 -or $review.reviews.Count -ne 18) { throw 'Unexpected case/review count' }
if (@($cases.id | Select-Object -Unique).Count -ne 36 -or @($rows.case_id | Select-Object -Unique).Count -ne 36) { throw 'Duplicate case IDs' }

foreach ($file in @('index.html','server.js','中国大陆景点知识库_初版.md','eval/rubric.md')) {
    $actualHash = (Get-FileHash -LiteralPath (Join-Path $projectRoot $file) -Algorithm SHA256).Hash.ToLower()
    if ($actualHash -ne $metadata.hashes.$file) { throw "Application/rubric changed during evaluation: $file" }
}

foreach ($file in @('test-cases.json','manual-scorecard.csv')) {
    $snapshot = Join-Path $runRoot ('pre-completion-' + $file)
    if (-not (Test-Path -LiteralPath $snapshot)) { Copy-Item -LiteralPath (Join-Path $evalRoot $file) -Destination $snapshot }
}

$priorRows = @(Import-Csv -LiteralPath (Join-Path $runRoot 'pre-completion-manual-scorecard.csv'))
$priorCases = @(Get-Content -Raw -LiteralPath (Join-Path $runRoot 'pre-completion-test-cases.json') | ConvertFrom-Json)
$initialDefinitions = @($priorCases | Select-Object id,group,name,turns,checkpoints) | ConvertTo-Json -Depth 10 -Compress
if ($definitions -ne $initialDefinitions) { throw 'Test definitions were modified' }

$newIds = @($review.reviews.id)
$enrichedReviews = @()
foreach ($item in $review.reviews) {
    $test = @($cases | Where-Object id -EQ $item.id)[0]
    $row = @($rows | Where-Object case_id -EQ $item.id)[0]
    if (-not $test -or -not $row) { throw "Missing case: $($item.id)" }
    if ($item.checkpoints.Count -ne $test.checkpoints.Count -or $item.scores.Count -ne 4) { throw "Wrong score length: $($item.id)" }
    if (@($item.scores + $item.checkpoints | Where-Object { $_ -notin @(0,1) }).Count) { throw "Nonbinary score: $($item.id)" }

    $resultPath = Join-Path $runRoot ($item.id + '-result.json')
    $result = Get-Content -Raw -LiteralPath $resultPath | ConvertFrom-Json
    if ($result.status -ne 'captured') { throw "Not captured: $($item.id)" }
    $last = if ($result.afterAdjustment) { $result.afterAdjustment } else { $result.turns[-1] }
    $resultTurns = $result.rawTurns | ConvertTo-Json -Compress
    $expectedTurns = $test.turns | ConvertTo-Json -Compress
    if ($resultTurns -ne $expectedTurns) { throw "Input definition mismatch: $($item.id)" }
    $modelCalls = @($last.network | Where-Object { $_.path -in @('/api/llm/plan','/api/llm/react') })
    $artifacts = @('eval/runs/2026-10-11-remaining/' + $item.id + '-result.json')
    foreach ($file in (Get-ChildItem -LiteralPath $runRoot -File | Where-Object { $_.Name -like ($item.id + '-*.png') })) {
        $artifacts += 'eval/runs/2026-10-11-remaining/' + $file.Name
    }
    foreach ($artifact in $artifacts) {
        if (-not (Test-Path -LiteralPath (Join-Path $projectRoot $artifact))) { throw "Missing evidence: $artifact" }
    }
    $passed = (@($item.scores | Where-Object { $_ -eq 0 }).Count -eq 0) -and (@($item.checkpoints | Where-Object { $_ -eq 0 }).Count -eq 0)
    $scores = [ordered]@{}
    for ($i=0; $i -lt 4; $i++) {
        $scores['D' + ($i+1)] = [int]$item.scores[$i]
        $row.('d' + ($i+1)) = [string]$item.scores[$i]
    }
    $row.checkpoint_results = $item.checkpoints -join ';'
    $row.primary_layer = $item.primaryLayer
    $row.secondary_layer = $item.secondaryLayer
    $row.critical_failure = if ($item.critical) { '是' } else { '否' }
    $row.evidence = $item.observed + ' 证据：' + $artifacts[0]
    $row.case_pass = if ($passed) { '是' } else { '否' }
    $row.notes = ($item.dimensionEvidence -join ' ') + ' ' + ($item.checkpointEvidence -join ' ') + ' 由助手依据浏览器证据判分，未做独立人工/机评一致率。'
    if ($item.limitations) { $row.notes += ' ' + $item.limitations }
    if ($item.intermediateIssue) { $row.notes += ' ' + $item.intermediateIssue }

    $baseline = [ordered]@{
        caseId=$item.id
        source='真实本地应用浏览器操作；详见证据路径及原始API记录'
        evaluatedAt=$review.reviewedAt; status='complete'; version='live-2026-10-11-index-723b5977b50e'
        model=$metadata.llmStatus.model; rater='assistant_evidence_review'; independentHumanLabel=$false
        scores=$scores; checkpointResults=@($item.checkpoints); primaryFailureLayer=$item.primaryLayer
        secondaryFailureLayer=$item.secondaryLayer; criticalFailure=[bool]$item.critical; casePass=$passed
        inputEvidence=@($result.turns | ForEach-Object form); auxiliaryInputs=$result.auxiliaryInputs
        observed=$item.observed; failure=$item.failure; scoringNotes=$row.notes
        dimensionEvidence=@($item.dimensionEvidence); checkpointEvidence=@($item.checkpointEvidence)
        evidenceFiles=$artifacts; controlledFixture=$result.fixture; tags=@($item.tags)
        formBlocked=(@($last.invalidFields).Count -gt 0); modelProcessed=($modelCalls.Count -gt 0)
    }
    if ($item.intermediateIssue) { $baseline.intermediateIssue = $item.intermediateIssue }
    if ($item.limitations) { $baseline.limitations = $item.limitations }
    Set-Field $test 'manualBaseline' $baseline
    $enrichedReviews += [pscustomobject]$baseline
}

foreach ($test in ($cases | Where-Object { $_.id -notin $newIds })) {
    $row = @($rows | Where-Object case_id -EQ $test.id)[0]
    $priorRow = @($priorRows | Where-Object case_id -EQ $test.id)[0]
    if (($row | ConvertTo-Json -Compress) -ne ($priorRow | ConvertTo-Json -Compress)) { throw "Prior row changed: $($test.id)" }
    if (-not $test.manualBaseline) {
        Set-Field $test 'manualBaseline' ([ordered]@{
            source='沿用已有CSV中用户截图证据；未重跑或改分'; evaluatedAt='2026-10-10'; status='complete'
            version='screenshot-version-unverified'; rater='assistant_review_of_user_screenshots'; independentHumanLabel=$false
            scores=[ordered]@{ D1=[int]$row.d1; D2=[int]$row.d2; D3=[int]$row.d3; D4=[int]$row.d4 }
            checkpointResults=@($row.checkpoint_results -split ';' | ForEach-Object { [int]$_ })
            primaryFailureLayer=$row.primary_layer; secondaryFailureLayer=$row.secondary_layer
            criticalFailure=($row.critical_failure -eq '是'); casePass=($row.case_pass -eq '是')
            observed=$row.evidence; scoringNotes=$row.notes
        })
    }
}

foreach ($row in $rows) {
    $test = @($cases | Where-Object id -EQ $row.case_id)[0]
    $baseline = $test.manualBaseline
    $passed = $true
    foreach ($i in 1..4) {
        $value = $row.('d' + $i)
        if ($value -notin @('0','1') -or [int]$value -ne $baseline.scores.('D' + $i)) { throw "Dimension mismatch: $($row.case_id)/D$i" }
        if ($value -eq '0') { $passed=$false }
    }
    $checkpoints = @($row.checkpoint_results -split ';')
    if ($checkpoints.Count -ne $test.checkpoints.Count) { throw "Checkpoint count mismatch: $($row.case_id)" }
    if (($baseline.checkpointResults -join ';') -ne $row.checkpoint_results) { throw "Checkpoint mismatch: $($row.case_id)" }
    foreach ($cp in $checkpoints) {
        if ($cp -notin @('0','1')) { throw "Invalid checkpoint: $($row.case_id)" }
        if ($cp -eq '0') { $passed=$false }
    }
    if ($passed -ne ($row.case_pass -eq '是') -or $passed -ne $baseline.casePass) { throw "Pass mismatch: $($row.case_id)" }
    if (($row.critical_failure -eq '是') -ne $baseline.criticalFailure) { throw "Critical mismatch: $($row.case_id)" }
    if ($row.primary_layer -ne $baseline.primaryFailureLayer) { throw "Layer mismatch: $($row.case_id)" }
}

Save-Json $cases $casePath
$rows | Export-Csv -LiteralPath $csvPath -NoTypeInformation -Encoding utf8
Save-Json $enrichedReviews (Join-Path $runRoot 'scored-evidence.json')

$metrics = [ordered]@{
    evaluatedAt=$review.reviewedAt; progress='36/36'; rubric='eval/rubric.md'
    overallCollection=Measure-Cases $rows
    liveRemainder=Measure-Cases @($rows | Where-Object { $_.case_id -in $newIds })
    previousScreenshotCollection=Measure-Cases @($rows | Where-Object { $_.case_id -notin $newIds })
    groups=[ordered]@{}
    formBlockedCaseIds=@($cases | Where-Object { $_.manualBaseline.formBlocked } | ForEach-Object id)
    controlledFixtureCaseIds=@($cases | Where-Object { $_.manualBaseline.controlledFixture } | ForEach-Object id)
    rater=$review.reviewer; independentHumanAgreement=$null; calibratedJudgeAgreement=$null
    limitations=@(
        '前18条为历史用户截图，版本未确认；后18条为固定文件哈希的真实浏览器运行。混合汇总不能作为同一版本v1完成率或版本提升。',
        '多轮表单修改证明可见状态保留，不证明自然语言修改自动解析；A08/A09使用明确标记的受控场景。',
        '表单拦截的A01/A04/A05/A10/A12没有进入模型。D3/D4或检查点通过仅代表观察到的非编造/静态边界，不代表主动安全拒绝能力。',
        '助手看截图/浏览器证据判分，尚非独立用户人工基准；未运行独立评委或计算人机一致率。',
        '每案例一次有效运行，没有估计随机波动；没有主动查询地图路段。'
    )
    originalDefinitionSha256=(Get-FileHash -LiteralPath (Join-Path $runRoot 'pre-completion-test-cases.json') -Algorithm SHA256).Hash.ToLower()
    validations=[ordered]@{ uniqueCases=36; scoredCases=36; csvJsonScoreMatch=$true; originalDefinitionsUnchanged=$true; previous18RowsPreserved=$true; evidencePathsExist=$true; applicationAndRubricUnchanged=$true }
}
foreach ($group in @('typical','boundary','adversarial')) {
    $metrics.groups[$group] = Measure-Cases @($rows | Where-Object group -EQ $group)
}
Save-Json $metrics (Join-Path $evalRoot 'baseline-metrics.json')

$all = $metrics.overallCollection
$live = $metrics.liveRemainder
$report = [System.Collections.Generic.List[string]]::new()
$report.Add('# 36条评测完成报告（2026-10-11）')
$report.Add('')
$report.Add('前18条沿用用户截图评分，后18条由助手操作真实本地应用并审阅证据补齐。共36/36，全部维度和检查点已填写。没有修改应用、模型配置、知识库或评分规则。')
$report.Add('')
$report.Add('## 结果')
$report.Add('')
$report.Add("- 混合历史记录完成：$($all.passed)/$($all.total)，任务完成率 $($all.taskCompletionRatePercent)%。它是记录汇总，不是固定版本v1成绩。")
$report.Add("- 本次18条真实运行：$($live.passed)/$($live.total)，任务完成率 $($live.taskCompletionRatePercent)%。仅代表剩余样本子集。")
$report.Add("- 全集检查点：$($all.checkpoints.passed)/$($all.checkpoints.total)，通过率 $($all.checkpoints.ratePercent)%。")
$report.Add("- 关键失败：$($all.criticalFailures.Count) 条（$($all.criticalFailures -join '、')）。")
$report.Add('')
$report.Add('|维度|通过/总数|比例|')
$report.Add('|---|---:|---:|')
foreach ($dim in $all.dimensions.Keys) {
    $value=$all.dimensions[$dim]
    $report.Add("|$dim|$($value.passed)/$($value.total)|$($value.ratePercent)%|")
}
$report.Add('')
$report.Add("综合四维得分：$($all.compositeDimensionRatePercent)%。严格任务完成需四维及所有检查点同时通过，不能用综合分代替完成率。")
$report.Add('')
$report.Add('|组别|通过/总数|任务完成率|')
$report.Add('|---|---:|---:|')
foreach ($group in $metrics.groups.Keys) {
    $value=$metrics.groups[$group]
    $report.Add("|$group|$($value.passed)/$($value.total)|$($value.taskCompletionRatePercent)%|")
}
$report.Add('')
$report.Add('|主要故障层|失败用例数|')
$report.Add('|---|---:|')
foreach ($layer in $all.primaryFailureLayers.Keys) { $report.Add("|$layer|$($all.primaryFailureLayers[$layer])|") }
$report.Add('')
$report.Add('## 本次逐条结果')
$report.Add('')
$report.Add('|编号|D1/D2/D3/D4|检查点|通过|主要层|关键失败|')
$report.Add('|---|---|---|---|---|---|')
foreach ($row in ($rows | Where-Object { $_.case_id -in $newIds })) {
    $report.Add("|$($row.case_id)|$($row.d1)/$($row.d2)/$($row.d3)/$($row.d4)|$($row.checkpoint_results)|$($row.case_pass)|$($row.primary_layer)|$($row.critical_failure)|")
}
$report.Add('')
$report.Add('## 主要失败与修复优先级')
$report.Add('')
$report.Add('1. A09：暴雨规则暂缓三个户外点，渲染时补齐又放回两个。先修复暂停/移除状态被覆盖的问题，确保摘要、活动表和导出一致。')
$report.Add('2. 北京门票：条目有价格描述，但ticketPriceCny缺失，预算仍0元并列未知。建立有来源、日期、票种的结构化预算参考，不随意把任一票价描述当成人票。')
$report.Add('3. B07/A08：模型理解或局部变更与最终展示不一致。轮椅核验警示藏在理由里；闭馆摘要未报告自动新增圆明园。关键警示应独立展示，变更摘要应按最终日程差异生成。')
$report.Add('4. 输入及冲突：表单阻断独立票务/付款/反编造请求；数量、步行和低预算冲突未形成协商选项。按真实产品支持边界改交互或调整后续产品定义，保留本次失败。')
$report.Add('5. 多轮及排程：B12最终条件通过，但前两轮仍有10.25小时过密日；A11也过密。后续回归需要检查每一轮，不仅检查最后状态。')
$report.Add('')
$report.Add('## 方法与限制')
$report.Add('')
foreach ($note in $metrics.limitations) { $report.Add('- ' + $note) }
$report.Add('')
$report.Add('日期映射：B09的4个月后固定2027-02-11，A05的明天固定2026-10-12；缺失辅助参数逐条存于result.json。场景适配、评分解释和每项证据见remaining-review.json/scored-evidence.json。')
$report.Add('')
$report.Add('## 记录纠正')
$report.Add('')
$report.Add('- 开始执行前实际CSV仅18条有完整分数，B07尚未写入；此前19/36口头进度不作为落盘事实。B07此次采用真实运行证据，原截图及既有18条分数不回改。')
$report.Add('- 原B08始终是北京1天8处深游。误给用户的上海含大交通样本另存supplemental-shanghai-2026-10-11.json，排除36条分母。')
$report.Add('- 原T01只有CSV评分，已将同一分数同步到JSON，未重跑或改分；前18条CSV行保持原值。')
$report.Add('')
$report.Add('## 后续如何用于简历')
$report.Add('')
$report.Add('现在可以写：构建36条覆盖典型、边界和对抗的测试集，按四维二元评分、用例检查点及四层故障归因完成有证据的评测记录。')
$report.Add('')
$report.Add('完成率提升、人机一致率暂没有证据。下一阶段先让独立人工复核一组覆盖各类失败的标签，再校准评委Prompt；随后固定版本对全部36条重跑，修复并回归，才能计算提升百分点。')
$report.Add('')
$report.Add('## 文件')
$report.Add('')
$report.Add('- manual-scorecard.csv：完整评分表；test-cases.json：原测试定义及逐条基准。')
$report.Add('- remaining-review.json：逐维/逐检查点评分依据；baseline-metrics.json：指标及校验。')
$report.Add('- runs/2026-10-11-remaining：输入、可见输出、API返回、截图、元数据和失败执行器尝试归档。')
$report | Set-Content -LiteralPath (Join-Path $evalRoot 'baseline-report.md') -Encoding utf8

$metrics | ConvertTo-Json -Depth 8
