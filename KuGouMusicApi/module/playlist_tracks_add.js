// 对歌单添加歌曲
// listid, 歌单listid
module.exports = (params, useAxios) => {
  const userid = params?.userid || params?.cookie?.userid || 0;
  const token = params?.token || params.cookie?.token || '';
  const clienttime = Math.floor(Date.now() / 1000);

  // Structured input preserves commas and pipes in titles; the legacy string contract remains supported.
  const structured = params.songs !== undefined;
  if (structured && (!Array.isArray(params.songs) || params.songs.length === 0 || params.songs.length > 1000)) {
    return Promise.resolve({ status: 400, headers: {}, cookie: [], body: { status: 0, error_code: 400, error: 'songs must contain 1–1000 entries' } });
  }
  const validId = (value) => value === undefined || value === null || value === '' ||
    ((typeof value === 'string' || typeof value === 'number') && /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)));
  if (structured && params.songs.some((song) => !song || typeof song !== 'object' ||
    typeof song.name !== 'string' || !song.name.trim() || song.name.length > 1000 ||
    typeof song.hash !== 'string' || !/^[a-z\d_-]{1,128}$/i.test(song.hash) ||
    !validId(song.album_id) || !validId(song.mixsongid ?? song.album_audio_id))) {
    return Promise.resolve({ status: 400, headers: {}, cookie: [], body: { status: 0, error_code: 400, error: 'invalid song entry' } });
  }
  const resource = structured ? params.songs.map((song) => ({
    number: 1,
    name: song.name,
    hash: song.hash,
    size: 0,
    sort: 0,
    timelen: 0,
    bitrate: 0,
    album_id: Number(song.album_id || 0),
    mixsongid: Number(song.mixsongid ?? song.album_audio_id ?? 0),
  })) : (params.data || '').split(',').map((s) => {
    const data = s.split('|');
    return {
      number: 1,
      name: data[0] || '',
      hash: data[1] || '',
      size: 0,
      sort: 0,
      timelen: 0,
      bitrate: 0,
      album_id: Number(data[2] || 0),
      mixsongid: Number(data[3] || 0),
    };
  });

  const dataMap = {
    userid,
    token,
    listid: params.listid,
    list_ver: 0,
    type: 0,
    slow_upload: 1,
    scene: 'false;null',
    data: resource,
  };

  return useAxios({
    url: '/cloudlist.service/v6/add_song',
    data: dataMap,
    params: { last_time: clienttime, last_area: 'gztx', userid, token },
    method: 'post',
    encryptType: 'android',
    cookie: params?.cookie || {},
  });
};
