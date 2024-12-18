import { Injectable, Logger } from '@nestjs/common'

import { SystemDatabase } from 'src/system-database'
import { Group } from './entities/group'
import { ClientSession, ObjectId } from 'mongodb'
import { GroupMemberService } from './group-member/group-member.service'
import { GroupMember, GroupRole } from './entities/group-member'
import { GroupApplication } from './entities/group-application'
import { GroupInviteService } from './group-invite/group-invite.service'
import { GroupApplicationService } from './group-application/group-application.service'

@Injectable()
export class GroupService {
  private readonly logger = new Logger(GroupService.name);
  private readonly db = SystemDatabase.db;

  constructor(
    private readonly memberService: GroupMemberService,
    private readonly inviteService: GroupInviteService,
    private readonly groupApplicationService: GroupApplicationService
  ) {}

  async findGroupByAppid(appid: string) {
    const res = await this.db.collection<Group>("Group").findOne({ appid });
    return res;
  }

  async findAll(uid: ObjectId) {
    try {
      const pipeline = [
        { $match: { uid } },
        {
          $lookup: {
            from: "Group",
            localField: "groupId",
            foreignField: "_id",
            pipeline: [{ $match: { appid: null } }],
            as: "group",
          },
        },
        { $unwind: "$group" },
        {
          $lookup: {
            from: "GroupMember",
            localField: "groupId",
            foreignField: "groupId",
            pipeline: [{ $project: { _id: 0, role: 1, uid: 1 } }],
            as: "members",
          },
        },
        {
          $project: {
            _id: "$group._id",
            name: "$group.name",
            createdAt: "$group.createdAt",
            updatedAt: "$group.updatedAt",
            members: "$members",
          },
        },
      ];

      const res = await this.db
        .collection<GroupMember>("GroupMember")
        .aggregate(pipeline)
        .toArray();

      return res;
    } catch (error) {
      console.error("Error fetching group members:", error);
      throw new Error("Failed to get group members");
    }
  }

  async countGroups(uid: ObjectId) {
    const count = await this.db
      .collection<Group>("Group")
      .countDocuments({ createdBy: uid, appid: { $exists: false } });

    return count;
  }

  async findGroupsByAppidAndUid(appid: string, uid: ObjectId) {
    try {
      const pipeline = [
        { $match: { appid } },
        {
          $lookup: {
            from: "Group",
            localField: "groupId",
            foreignField: "_id",
            as: "group",
          },
        },
        { $unwind: "$group" },
        {
          $lookup: {
            from: "GroupMember",
            let: { groupId: "$groupId" },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $eq: ["$groupId", "$$groupId"] },
                      { $eq: ["$uid", uid] },
                    ],
                  },
                },
              },
            ],
            as: "member",
          },
        },
        { $unwind: "$member" },
        {
          $project: {
            _id: "$group._id",
            name: "$group.name",
            createdAt: "$group.createdAt",
            updatedAt: "$group.updatedAt",
            role: "$member.role",
          },
        },
      ];

      const res = await this.db
        .collection<GroupApplication>("GroupApplication")
        .aggregate(pipeline)
        .toArray();

      return res;
    } catch (error) {
      console.error("Error fetching groups by appid and uid:", error);
      throw new Error("Failed to get groups data");
    }
  }

  async update(groupId: ObjectId, dto: Partial<Group>) {
    const res = await this.db.collection<Group>("Group").findOneAndUpdate(
      { _id: groupId },
      {
        $set: {
          ...dto,
          updatedAt: new Date(),
        },
      },
      { returnDocument: "after" }
    );
    return res.value;
  }

  async findOne(groupId: ObjectId, session?: ClientSession) {
    const res = await this.db
      .collection<Group>("Group")
      .findOne({ _id: groupId }, { session });
    return res;
  }

  async findOneWithRole(groupId: ObjectId, uid: ObjectId) {
    const pipeline = [
      { $match: { groupId, uid } },
      {
        $lookup: {
          from: "Group",
          localField: "groupId",
          foreignField: "_id",
          as: "group",
        },
      },
      { $unwind: "$group" }, // 确保 group 是一个对象而不是数组
      {
        $project: {
          _id: "$group._id",
          name: "$group.name",
          createdAt: "$group.createdAt",
          updatedAt: "$group.updatedAt",
          role: "$role",
        },
      },
    ];

    const res = await this.db
      .collection<GroupMember>("GroupMember")
      .aggregate(pipeline)
      .next();

    return res;
  }

  async create(name: string, createdBy: ObjectId, appid?: string) {
    const session = SystemDatabase.client.startSession();
    try {
      let group: Group;
      await session.withTransaction(async () => {
        const res = await this.db.collection<Group>("Group").insertOne(
          {
            name,
            appid,
            createdBy: createdBy,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          {
            session,
          }
        );

        await this.memberService.addOne(
          res.insertedId,
          createdBy,
          GroupRole.Owner,
          session
        );

        await this.groupApplicationService.append(
          res.insertedId,
          appid,
          session
        );

        group = await this.findOne(res.insertedId, session);
      });

      return group;
    } catch (err) {
      this.logger.error("create group error", err);
      throw err;
    } finally {
      await session.endSession();
    }
  }

  async delete(groupId: ObjectId, session?: ClientSession) {
    let needEndSession = false;
    if (!session) {
      session = SystemDatabase.client.startSession();
      needEndSession = true;
    }
    const group = await this.findOne(groupId, session);

    try {
      session.startTransaction();
      // delete group
      await this.db
        .collection<Group>("Group")
        .deleteOne({ _id: groupId }, { session });

      // delete group members
      await this.memberService.removeAll(groupId, session);
      await this.inviteService.deleteManyInviteCode(groupId, session);
      await this.groupApplicationService.removeAll(groupId, session);

      await session.commitTransaction();

      return group;
    } catch (err) {
      this.logger.error(`delete group ${groupId} error`, err);
      await session.abortTransaction();
      throw err;
    } finally {
      if (needEndSession) {
        await session.endSession();
      }
    }
  }
}
