# K8s Integrity Test Failure Diagnosis and Fix Plan

## Executive Summary

The K8s integrity tests on `cloud-runner-develop` have been failing consistently since September 2025. The last
successful runs were in early September 2025 (commits 464a9d1, 98963da). Since then, we've added extensive disk pressure
handling, cleanup logic, and resource management, but tests continue to fail with pod evictions and disk pressure
issues.

## Key Findings

### 1. Successful Configuration (September 2025)

**Workflow Characteristics:**

- **Simple k3d cluster creation**: `k3d cluster create unity-builder --agents 1 --wait`
- **No pre-cleanup**: Cluster created directly without aggressive cleanup
- **No disk pressure handling**: No taint detection or removal logic
- **No image pre-pulling**: Images pulled on-demand during tests
- **Simple test execution**: Direct test runs without intermediate cleanup
- **Kubectl version**: v1.29.0
- **k3d version**: Latest (v5.8.3 equivalent)

**Key Differences:**

```yaml
# Successful version (464a9d1)
- name: Create k3s cluster (k3d)
  run: |
    k3d cluster create unity-builder --agents 1 --wait
    kubectl config current-context | cat
```

### 2. Current Configuration (December 2025)

**Workflow Characteristics:**

- **Complex cleanup before cluster creation**: `k3d cluster delete`, `docker system prune`
- **Extensive disk pressure handling**: Taint detection, removal loops, cleanup retries
- **Image pre-pulling**: Attempts to pre-pull Unity image (3.9GB) into k3d node
- **Aggressive cleanup between tests**: PVC deletion, PV cleanup, containerd cleanup
- **Kubectl version**: v1.34.1 (newer)
- **k3d version**: v5.8.3

**Current Issues:**

1. **Pod evictions due to disk pressure** - Even after cleanup, pods get evicted
2. **PreStopHook failures** - Pods killed before graceful shutdown
3. **Exit code 137** - OOM kills (memory pressure) or disk evictions
4. **"Collected Logs" missing** - Pods terminated before post-build completes
5. **Disk usage at 96%** - Cleanup not effectively freeing space

## Root Cause Analysis

### Primary Issue: Disk Space Management

**Problem**: GitHub Actions runners have limited disk space (~72GB total), and k3d nodes share this space with:

- Docker images (Unity image: 3.9GB)
- k3s/containerd data
- PVC storage (5Gi per test)
- Logs and temporary files
- System overhead

**Why Current Approach Fails:**

1. **Cleanup happens too late**: Disk pressure taints appear after space is already exhausted
2. **Cleanup is ineffective**: `crictl rmi --prune` and manual cleanup don't free enough space
3. **Image pre-pulling makes it worse**: Pulling 3.9GB image before tests reduces available space
4. **PVC accumulation**: Multiple tests create 5Gi PVCs that aren't cleaned up fast enough
5. **Ephemeral storage requests**: Even though removed for tests, k3s still tracks usage

### Secondary Issues

1. **k3d/k3s version compatibility**: Newer k3d (v5.8.3) with k3s v1.31.5 may have different resource management
2. **Kubectl version mismatch**: v1.34.1 client with v1.31.5 server may cause issues
3. **LocalStack connectivity**: `host.k3d.internal` DNS resolution failures in some cases
4. **Test timeout**: 5-minute timeout may be too short for cleanup + test execution

## Fix Plan

### Phase 1: Simplify and Stabilize (Immediate)

**Goal**: Return to a simpler, more reliable configuration similar to successful runs.

#### 1.1 Revert to Simpler k3d Configuration

```yaml
- name: Create k3s cluster (k3d)
  run: |
    # Only delete if exists, no aggressive cleanup
    k3d cluster delete unity-builder || true
    # Create with minimal configuration
    k3d cluster create unity-builder \
      --agents 1 \
      --wait \
      --k3s-arg '--kubelet-arg=eviction-hard=imagefs.available<5%,memory.available<100Mi@agent:*'
    kubectl config current-context | cat
```

**Rationale**:

- Set eviction thresholds explicitly to prevent premature evictions
- Don't pre-cleanup aggressively (may cause issues)
- Let k3s manage resources naturally

#### 1.2 Reduce PVC Size

- Change `KUBE_VOLUME_SIZE` from `5Gi` to `2Gi` for tests
- Tests don't need 5GB, and this reduces pressure significantly

#### 1.3 Remove Image Pre-pulling

- Remove the "Pre-pull Unity image" step
- Let images pull on-demand (k3s handles caching)
- Pre-pulling uses space that may be needed later

#### 1.4 Simplify Cleanup Between Tests

- Keep PVC cleanup but remove aggressive containerd cleanup
- Remove disk pressure taint loops (they're not effective)
- Trust k3s to manage resources

#### 1.5 Match Kubectl Version to k3s

- Use kubectl v1.31.x to match k3s v1.31.5
- Or pin k3d to use compatible k3s version

### Phase 2: Resource Optimization (Short-term)

#### 2.1 Use Smaller Test Images

- Consider using a smaller Unity base image for tests
- Or use a minimal test image that doesn't require 3.9GB

#### 2.2 Implement PVC Reuse

- Reuse PVCs across tests instead of creating new ones
- Only create new PVC if previous one is still in use

#### 2.3 Add Resource Limits

- Set explicit resource limits on test pods
- Prevent pods from consuming all available resources

#### 2.4 Optimize Job TTL

- Keep `ttlSecondsAfterFinished: 300` (5 minutes)
- Ensure jobs are cleaned up promptly

### Phase 3: Monitoring and Diagnostics (Medium-term)

#### 3.1 Add Disk Usage Monitoring

- Log disk usage before/after each test
- Track which components use most space
- Alert when usage exceeds thresholds

#### 3.2 Improve Error Messages

- Detect evictions explicitly and provide clear errors
- Log disk pressure events with context
- Show available vs. requested resources

#### 3.3 Add Retry Logic

- Retry tests that fail due to infrastructure issues (evictions)
- Skip retry for actual test failures

## Implementation Steps

### Step 1: Immediate Fixes (High Priority)

1. ✅ Remove image pre-pulling step
2. ✅ Simplify k3d cluster creation (remove aggressive cleanup)
3. ✅ Reduce PVC size to 2Gi
4. ✅ Remove disk pressure taint loops
5. ✅ Match kubectl version to k3s version

### Step 2: Test and Validate

1. Run integrity checks multiple times
2. Monitor disk usage patterns
3. Verify no evictions occur
4. Check test reliability

### Step 3: Iterate Based on Results

1. If still failing, add eviction thresholds
2. If space is issue, implement PVC reuse
3. If timing is issue, increase timeouts

## Expected Outcomes

### Success Criteria

- ✅ All K8s integrity tests pass consistently
- ✅ No pod evictions during test execution
- ✅ Disk usage stays below 85%
- ✅ Tests complete within timeout (5 minutes)
- ✅ "Collected Logs" always present in output

### Metrics to Track

- Test pass rate (target: 100%)
- Average disk usage during tests
- Number of evictions per run
- Test execution time
- Cleanup effectiveness

## Risk Assessment

### Low Risk Changes

- Removing image pre-pulling
- Reducing PVC size
- Simplifying cleanup

### Medium Risk Changes

- Changing k3d configuration
- Modifying eviction thresholds
- Changing kubectl version

### High Risk Changes

- PVC reuse (requires careful state management)
- Changing k3s version
- Major workflow restructuring

## Rollback Plan

If changes make things worse:

1. Revert to commit 464a9d1 workflow configuration
2. Gradually add back only essential changes
3. Test each change individually

## Timeline

- **Phase 1**: 1-2 days (immediate fixes)
- **Phase 2**: 3-5 days (optimization)
- **Phase 3**: 1 week (monitoring)

## Notes

- The successful September runs used a much simpler approach
- Complexity has increased without solving the root problem
- Simplification is likely the key to reliability
- GitHub Actions runners have limited resources - we must work within constraints
